import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Bot, Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { run, sequentialize, RunnerHandle } from '@grammyjs/runner';
import { AccessService, UNAUTHORIZED_MESSAGE } from '../access/access.service';
import { ChatService } from '../chat/chat.service';
import { SlidingWindowLimiter } from '../common/utils/rate-limiter';
import { safeErrorMessage } from '../common/utils/scrub';
import { Metrics } from '../common/metrics.service';
import { AppConfig } from '../config/app-config.service';
import { NotifierService } from '../notifier/notifier.service';
import { isTestRuntime, TELEGRAM_DISABLED_IN_TEST } from './runtime-guard';
import { SenderGate } from './sender-gate';

export type TelegramStatus = 'connected' | 'disabled' | 'error';

/** Telegram's shared sender ids: GroupAnonymousBot, Channel_Bot and the Telegram service account. */
const SHARED_SENDER_IDS = new Set([1087968824, 136817688, 777000]);

/** True when the update does not identify one real person (anonymous admin, channel, service account). */
function isSharedIdentity(ctx: Context): boolean {
  const msg = ctx.msg as { sender_chat?: unknown } | undefined;
  return msg?.sender_chat !== undefined || SHARED_SENDER_IDS.has(ctx.from?.id ?? -1);
}

/** Seconds Telegram asks us to wait after a 429, or null for any other error. */
export function retryAfterSeconds(e: unknown): number | null {
  const err = e as { error_code?: number; parameters?: { retry_after?: number } } | null;
  if (!err || err.error_code !== 429) return null;
  const wait = err.parameters?.retry_after;
  return typeof wait === 'number' && Number.isFinite(wait) && wait >= 0 ? wait : 1;
}

/** Telegram allows about 20 bot messages per minute into one group; a margin is kept for retries. */
export const GROUP_BUDGET_PER_MINUTE = 15;
/** Longest we wait for Telegram's `retry_after` before giving up on a real answer. */
const MAX_RETRY_AFTER_SECONDS = 65;

const SEND_OPTS = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot?: Bot;
  private runner?: RunnerHandle;
  private botUsername = '';
  /** Bounds in-flight updates per sender before they can occupy runner slots. */
  private readonly gate = new SenderGate();
  /** Messages a group chat receives from the bot per minute; Telegram allows about 20. */
  private readonly groupBudget = new SlidingWindowLimiter(GROUP_BUDGET_PER_MINUTE, 60_000);
  /**
   * One member's share of that budget: a member who alone sends more than half of what the group may
   * receive gets their further answers dropped (with one notice a minute) so the other members' answers fit.
   */
  private readonly groupSenderBudget = new SlidingWindowLimiter(
    Math.ceil(GROUP_BUDGET_PER_MINUTE / 2),
    60_000,
  );
  private readonly groupSenderNotice = new SlidingWindowLimiter(1, 60_000);
  private state: { status: TelegramStatus; detail: string } = {
    status: 'disabled',
    detail: 'TELEGRAM_BOT_TOKEN belum diisi',
  };

  constructor(
    private readonly config: AppConfig,
    private readonly chat: ChatService,
    private readonly notifier: NotifierService,
    private readonly access: AccessService,
    private readonly metrics: Metrics,
  ) {}

  get health(): { status: TelegramStatus; detail: string; username?: string } {
    return { ...this.state, username: this.botUsername || undefined };
  }

  async onModuleInit(): Promise<void> {
    const token = this.config.get('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN is empty: Telegram is disabled (REST API and `npm run chat` still work).',
      );
      return;
    }
    if (this.config.get('BOT_ROLE') === 'worker') {
      this.state = {
        status: 'disabled',
        detail: 'proses worker (BOT_ROLE=worker) tidak menjalankan Telegram',
      };
      this.logger.log('BOT_ROLE=worker: Telegram transport is not started in this process.');
      return;
    }
    if (this.config.get('TELEGRAM_ENABLED') === false) {
      this.state = { status: 'disabled', detail: 'dinonaktifkan (TELEGRAM_ENABLED=false)' };
      this.logger.warn('TELEGRAM_ENABLED=false: Telegram transport is not started.');
      return;
    }
    // Test boundary: never start real long polling from a test/probe process, whatever the token
    // source was (see runtime-guard.ts). Checked at runtime, before any network call.
    if (isTestRuntime() || this.config.get('NODE_ENV') === 'test') {
      this.state = { status: 'disabled', detail: 'dinonaktifkan di lingkungan test' };
      this.logger.warn(JSON.stringify({ evt: TELEGRAM_DISABLED_IN_TEST }));
      return;
    }

    const bot = this.buildBot(token);
    this.bot = bot;

    // Start in the background so a slow/failed Telegram connection never blocks app startup.
    void this.start(bot);
  }

  /**
   * Creates the bot and installs its middleware. Order is a security property:
   *  1) authorization (rejects everyone not on the allowlist before ANYTHING else runs),
   *  2) per-chat sequencing,
   *  3) message handlers.
   * Public so tests can drive it with a stubbed Telegram API (`botInfo` skips the getMe call).
   */
  buildBot(token: string, botInfo?: UserFromGetMe): Bot {
    const bot = new Bot(token, botInfo ? { botInfo } : undefined);
    bot.catch((err) => this.logger.error(`Telegram handler error: ${safeErrorMessage(err.error)}`));

    bot.use(async (ctx, next) => {
      const id = ctx.from?.id;
      if (id !== undefined && this.access.isAllowed(id)) {
        // Anonymous group admins and "send as channel" posts all arrive under one shared Telegram
        // id. Treating that id as a person would merge unrelated people into ONE user (shared
        // watchlist, alerts and quotas), so such updates are ignored before any state is touched.
        if (isSharedIdentity(ctx)) {
          this.logger.warn(
            JSON.stringify({ evt: 'ANONYMOUS_SENDER_IGNORED', chatType: ctx.chat?.type }),
          );
          return;
        }
        return next();
      }
      // Unauthorized (or sender-less) update: stop here. Nothing downstream may run.
      if (id !== undefined) {
        const n = this.access.noteRejection(id);
        if (n.shouldReply && ctx.chat?.type === 'private') {
          await ctx.reply(UNAUTHORIZED_MESSAGE).catch(() => undefined);
        }
      }
    });

    // Before anything can wait: at most a few updates per sender are in flight. An update that waits in
    // `sequentialize` still holds one of the runner's 500 slots, so without this bound a single account could
    // queue hundreds of messages behind one slow AI request and stop the bot for everybody.
    bot.use(async (ctx, next) => {
      const key = `${ctx.chat?.id ?? 'x'}:${ctx.from?.id ?? 'x'}`;
      const verdict = this.gate.enter(key);
      if (!verdict.admitted) {
        if (verdict.notify && ctx.chat?.type === 'private') {
          await ctx
            .reply('Pesan sebelumnya masih diproses. Tunggu sebentar ya.')
            .catch(() => undefined);
        }
        return;
      }
      try {
        await next();
      } finally {
        this.gate.leave(key);
      }
    });

    // Updates are processed in order PER SENDER IN A CHAT, not per chat: a group member whose message
    // triggers minutes of AI work (up to 5 analyses on a CPU model) must not hold up every other member's
    // /help or quote in that group. One user's own messages still keep their order.
    bot.use(sequentialize((ctx) => `${ctx.chat?.id ?? 'x'}:${ctx.from?.id ?? 'x'}`));
    bot.on('message:text', (ctx) => this.onText(ctx));
    bot.on('message', (ctx) =>
      ctx.chat.type === 'private'
        ? ctx
            .reply('Saya hanya bisa membaca pesan teks. Ketik /help untuk contoh.')
            .then(() => undefined)
        : undefined,
    );
    return bot;
  }

  private async start(bot: Bot): Promise<void> {
    // Defence in depth: even if a future caller bypasses onModuleInit, a test process can never poll.
    if (isTestRuntime()) throw new Error(TELEGRAM_DISABLED_IN_TEST);
    try {
      await bot.init(); // validates the token via getMe
      this.botUsername = bot.botInfo.username;
      await bot.api.deleteWebhook({ drop_pending_updates: false }); // polling needs no webhook
      await bot.api.setMyCommands([
        { command: 'start', description: 'Mulai' },
        { command: 'help', description: 'Bantuan & contoh' },
      ]);
      this.notifier.register(async (chatId, html) => {
        try {
          await bot.api.sendMessage(chatId, html, SEND_OPTS);
        } catch (e) {
          if (/can't parse entities/i.test(String((e as Error).message))) {
            await bot.api.sendMessage(chatId, stripTags(html));
          } else {
            this.metrics.inc('telegram_errors_total', { kind: 'notify' });
            throw e;
          }
        }
      });
      this.runner = run(bot);
      this.state = { status: 'connected', detail: `@${this.botUsername} (long polling)` };
      this.logger.log(`Telegram long polling started as @${this.botUsername}`);
      void this.runner.task()?.catch((e) => {
        this.state = { status: 'error', detail: 'polling berhenti' };
        this.metrics.inc('telegram_errors_total', { kind: 'polling' });
        this.logger.error(`Telegram polling stopped: ${safeErrorMessage(e)}`);
      });
    } catch (e) {
      this.state = { status: 'error', detail: 'tidak dapat terhubung / token tidak valid' };
      this.metrics.inc('telegram_errors_total', { kind: 'start' });
      this.logger.error(`Telegram start failed: ${safeErrorMessage(e)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.runner?.stop();
    } catch {
      /* shutting down */
    }
  }

  private async onText(ctx: Context): Promise<void> {
    const msg = ctx.message;
    const from = ctx.from;
    if (!msg?.text || !from || !ctx.chat) return;

    const addressed = this.addressedText(msg.text, ctx.chat.type !== 'private');
    if (addressed === null) return;
    const text = addressed;

    const typing = setInterval(
      () => void ctx.replyWithChatAction('typing').catch(() => undefined),
      4000,
    );
    void ctx.replyWithChatAction('typing').catch(() => undefined);
    try {
      const reply = await this.chat.handle({
        telegramId: from.id,
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
        text,
        messageId: msg.message_id,
        progress: async (html) => {
          await this.send(ctx, html);
        },
      });
      for (const m of reply.messages) await this.send(ctx, m);
    } finally {
      clearInterval(typing);
    }
  }

  /**
   * The text Indonesian Stock Bot should answer, or null when the message is not for Indonesian Stock Bot.
   *  - A command may carry a target ("/stock@some_bot"). One aimed at ANOTHER bot is ignored; before the
   *    bot's own username is known, targeted commands are ignored too.
   *  - In groups, plain text counts only when it contains "@ourbot" as a whole handle: "@ourbot2" or
   *    "name@ourbot.example" are not mentions. The handle is removed from the text.
   */
  private addressedText(raw: string, group: boolean): string | null {
    const own = this.botUsername ? this.botUsername.toLowerCase() : '';
    const command = /^\/[A-Za-z0-9_]+(?:@([A-Za-z0-9_]+))?(?=\s|$)/.exec(raw);
    if (command) {
      const target = command[1]?.toLowerCase();
      if (target && target !== own) return null;
      return raw;
    }
    if (!group) return raw;
    if (!own) return null;
    const handle = new RegExp(`(?<![A-Za-z0-9_])@${own}(?![A-Za-z0-9_])`, 'ig');
    if (!handle.test(raw)) return null;
    return raw.replace(handle, ' ');
  }

  private async send(ctx: Context, html: string): Promise<void> {
    const cosmetic = html.startsWith('⏳') || html.startsWith('⏱️');
    // A group receives at most ~20 bot messages a minute from Telegram's side. Once this chat's budget is
    // spent, cosmetic messages (progress, "too many messages") are dropped so that real answers still fit.
    if (ctx.chat && ctx.chat.type !== 'private') {
      const chatKey = String(ctx.chat.id);
      const senderKey = `${chatKey}:${ctx.from?.id ?? 'x'}`;
      if (!cosmetic && !this.groupSenderBudget.tryConsume(senderKey).allowed) {
        // this member alone would use the whole group's budget: their answer is dropped, others' are not
        if (
          this.groupSenderNotice.tryConsume(senderKey).allowed &&
          this.groupBudget.tryConsume(chatKey).allowed
        ) {
          await ctx
            .reply(
              '⏱️ Terlalu banyak permintaan dari kamu di grup ini. Lanjutkan di chat pribadi dengan saya.',
            )
            .catch(() => undefined);
        }
        return;
      }
      const inBudget = this.groupBudget.tryConsume(chatKey).allowed;
      if (!inBudget && cosmetic) return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await ctx.reply(html, SEND_OPTS);
        return;
      } catch (e) {
        if (/can't parse entities/i.test(String((e as Error).message))) {
          await ctx.reply(stripTags(html)).catch(() => undefined);
          return;
        }
        const wait = retryAfterSeconds(e);
        // Telegram flood control: a real answer waits for the requested time (up to a bound) and is sent once
        // more instead of being lost; a cosmetic message is simply dropped.
        if (wait !== null && !cosmetic && wait <= MAX_RETRY_AFTER_SECONDS && attempt < 1) {
          await new Promise((r) => setTimeout(r, wait * 1000 + 250));
          continue;
        }
        this.metrics.inc('telegram_errors_total', { kind: wait !== null ? 'flood' : 'send' });
        this.logger.error(`sendMessage failed: ${safeErrorMessage(e)}`);
        return;
      }
    }
  }
}
