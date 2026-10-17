import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccessService, UNAUTHORIZED_MESSAGE } from '../access/access.service';
import { BackgroundTasks } from '../common/background-tasks.service';
import { randomUUID } from 'node:crypto';
import { CallerContext } from '../common/caller-context';
import { Metrics } from '../common/metrics.service';
import { QUOTA_STORE } from '../stock/governance/market-data-governor';
import { QuotaStore } from '../stock/governance/quota-store';
import { UserFacingError } from '../common/exceptions/app-errors';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { ConversationService } from '../conversation/conversation.service';
import { IntentService } from '../intent/intent.service';
import { normalizeText } from '../intent/intent-parser';
import { IntentName } from '../intent/intent.types';
import { NEEDS_SYMBOL, SINGLE_SYMBOL_ONLY } from '../intent/intent-validator';
import {
  SINGLE_SYMBOL_MESSAGE,
  inputTooLongMessage,
  symbolLimitMessage,
} from '../telegram/policy-messages';
import { readPreferences } from '../user/user-preferences';
import { UserService } from '../user/user.service';
import { chunkMessage, HELP_TEXT, START_TEXT } from '../telegram/telegram-response';
import { ChatReply, ChatRequest, HandlerContext } from './chat.types';
import { GeneralHandler } from './handlers/general.handler';
import { KnowledgeHandler, NOTES_PRIVATE_ONLY } from './handlers/knowledge.handler';
import { MEMORY_PRIVATE_ONLY, MemoryHandler } from './handlers/memory.handler';
import {
  PORTFOLIO_PRIVATE_ONLY,
  PortfolioLedgerHandler,
} from './handlers/portfolio-ledger.handler';
import { WatchlistAlertHandler } from './handlers/watchlist-alert.handler';
import { StockHandler } from './handlers/stock.handler';

const GENERIC_ERROR =
  '⚠️ Maaf, terjadi kendala saat memproses permintaanmu. Silakan coba lagi sebentar lagi.';
const DB_ERROR =
  '⚠️ Layanan penyimpanan sedang bermasalah, jadi permintaan ini belum bisa diproses. Coba lagi sebentar lagi.';
const ASK_SYMBOL = 'Saham mana yang kamu maksud? Sebutkan kode sahamnya, mis. "BBCA".';
/** A watchlist is personal: it is only shown or edited in the private chat, never in a group. */
const WATCHLIST_PRIVATE_ONLY =
  'Watchlist bersifat pribadi, jadi hanya bisa dilihat atau diubah lewat chat pribadi dengan bot ini.';

/** Read-only intents a user's default ticker may complete. Never a state-changing one. */
const DEFAULT_SYMBOL_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
  'STOCK_QUOTE',
  'STOCK_HISTORICAL',
  'STOCK_TECHNICAL',
  'STOCK_ANALYSIS',
  'STOCK_QUESTION',
  'FOREIGN_FLOW',
  'BROKER_SUMMARY',
  'FUNDAMENTALS',
]);

/** Optional slash commands -> natural language, so both styles share one code path. */
export function commandToText(command: string, args: string): string | null {
  const a = args.trim();
  switch (command) {
    case 'stock':
    case 'price':
      return `harga ${a}`;
    case 'analyze':
    case 'analysis':
      return `analisis ${a}`;
    case 'technical':
      return `teknikal ${a}`;
    case 'compare':
      return `bandingkan ${a}`;
    case 'watchlist':
      return 'lihat watchlist saya';
    case 'alerts':
      return 'lihat alert saya';
    case 'pengaturan':
    case 'settings':
      return 'pengaturan saya';
    case 'lupakan':
      return 'lupakan konteks obrolan';
    case 'hapusdata':
      return a.toLowerCase() === 'konfirmasi' ? 'konfirmasi hapus data saya' : 'hapus data saya';
    case 'catatan':
    case 'catat':
      return a ? `catat: ${a}` : 'catatan saya';
    case 'news':
    case 'berita':
      return `berita ${a}`;
    default:
      return null;
  }
}

/**
 * Transport-agnostic conversation pipeline: text in, HTML messages out.
 * Telegram, the CLI chat tool and tests all use this.
 *
 * Order matters (cheapest/safest first): authorization -> rate limit -> user -> intent -> limits ->
 * handler. Nothing expensive (DB, providers, AI) runs for a sender that fails authorization.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  /** Messages per user per minute; shared across processes when Redis is configured. */
  private userLimitPerMinute: number;
  private readonly maxSymbols: number;
  private readonly maxInput: number;
  private readonly requestDeadlineMs: number;

  constructor(
    config: AppConfig,
    private readonly access: AccessService,
    private readonly users: UserService,
    private readonly conversation: ConversationService,
    private readonly intents: IntentService,
    private readonly stock: StockHandler,
    private readonly lists: WatchlistAlertHandler,
    private readonly ledger: PortfolioLedgerHandler,
    private readonly general: GeneralHandler,
    private readonly memory: MemoryHandler,
    private readonly knowledge: KnowledgeHandler,
    private readonly background: BackgroundTasks,
    private readonly metrics: Metrics,
    @Inject(QUOTA_STORE) private readonly quota: QuotaStore,
  ) {
    this.userLimitPerMinute = config.get('USER_RATE_LIMIT_PER_MINUTE');
    this.maxSymbols = config.get('MAX_SYMBOLS_PER_REQUEST');
    this.maxInput = config.get('MAX_INPUT_LENGTH');
    this.requestDeadlineMs = config.get('CHAT_REQUEST_DEADLINE_MS');
  }

  async handle(req: ChatRequest): Promise<ChatReply> {
    // Everything below that reaches the market-data provider is charged to this sender, and provider
    // calls still queued when the request has taken too long are cancelled instead of running for nobody.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.requestDeadlineMs);
    deadline.unref?.();
    try {
      return await CallerContext.run(
        `tg:${req.telegramId}`,
        () => this.handleCore(req),
        controller.signal,
      );
    } finally {
      clearTimeout(deadline);
    }
  }

  private async handleCore(req: ChatRequest): Promise<ChatReply> {
    // 0) Authorization boundary: before rate limiting, DB access, intent detection or AI.
    if (!req.trusted && !this.access.isAllowed(req.telegramId)) {
      this.access.noteRejection(req.telegramId);
      return { messages: [UNAUTHORIZED_MESSAGE], intent: 'UNKNOWN', unauthorized: true };
    }

    const started = Date.now();
    // a random correlation id: ties this request's log lines together without identifying anyone
    const log: Record<string, unknown> = {
      evt: 'chat',
      reqId: randomUUID().slice(0, 8),
      telegramId: req.telegramId,
    };
    let intentName: IntentName = 'UNKNOWN';
    let status = 'ok';
    let messages: string[];

    try {
      const rate = await this.quota.consume(
        'chat',
        String(req.telegramId),
        this.userLimitPerMinute,
        60_000,
      );
      if (!rate.allowed) {
        status = 'rate_limited';
        messages = [`⏱️ Terlalu banyak pesan. Coba lagi dalam ${rate.retryAfterSeconds} detik.`];
        return { messages, intent: intentName };
      }

      // Input size is bounded BEFORE any parsing, database write or AI work.
      if (req.text.length > this.maxInput) {
        status = 'input_too_long';
        log.inputLength = req.text.length;
        this.logger.warn(
          JSON.stringify({ evt: 'AI_INPUT_TOO_LONG', length: req.text.length, max: this.maxInput }),
        );
        return {
          messages: [inputTooLongMessage(this.maxInput)],
          intent: intentName,
        };
      }

      const chatType = req.chatType ?? 'private';
      const user = await this.users.upsertFromTelegram({
        telegramId: req.telegramId,
        chatId: req.chatId,
        chatType,
        username: req.username,
        firstName: req.firstName,
        lastName: req.lastName,
      });

      let text = normalizeText(req.text);
      if (text.startsWith('/')) {
        const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
        const cmd = rawCmd.split('@')[0].toLowerCase();
        if (cmd === 'start') return this.reply('HELP', START_TEXT);
        if (cmd === 'help') return this.reply('HELP', HELP_TEXT);
        const mapped = commandToText(cmd, rest.join(' '));
        if (!mapped) return this.reply('HELP', HELP_TEXT);
        text = mapped;
      }

      const intentStarted = Date.now();
      const context = await this.conversation.get(user.id, req.chatId);
      let intent = await this.intents.resolve(text, context, user.id);
      log.intentMs = Date.now() - intentStarted;
      // A question without a ticker and without chat context falls back to the user's own default
      // ticker (private chat only: a preference is personal), and only for read-only intents.
      const prefs = chatType === 'private' ? readPreferences(user.preferences) : {};
      if (
        prefs.defaultSymbol &&
        intent.symbols.length === 0 &&
        !intent.clarification &&
        DEFAULT_SYMBOL_INTENTS.has(intent.intent)
      ) {
        intent = { ...intent, symbols: [prefs.defaultSymbol], source: 'context' };
        log.defaultSymbol = true;
      }
      intentName = intent.intent;
      log.intent = intent.intent;
      log.symbols = intent.symbols;
      log.intentSource = intent.source;
      if (intent.ai) log.aiIntent = intent.ai;

      const hctx: HandlerContext = {
        user,
        chat: { id: req.chatId, type: chatType },
        messageId: req.messageId,
        intent,
        progress: req.progress,
        log,
      };
      messages = await this.dispatch(hctx);

      // a settings command is not a lookup: it must not become the chat context ("ingatkan saya kalau di
      // atas 1000" right after "saham default saya BBCA" would otherwise silently target BBCA)
      if (
        intent.symbols.length > 0 &&
        intent.intent !== 'WATCHLIST_REMOVE' &&
        intent.intent !== 'PREFERENCE_SET'
      ) {
        // Awaited (a few ms) so an immediate follow-up message always sees this context.
        await this.conversation.remember(user.id, req.chatId, intent.symbols, intent.intent);
      }
    } catch (error) {
      status = 'error';
      messages = [this.toUserMessage(error, log)];
    } finally {
      log.status = status;
      const latencyMs = Date.now() - started;
      log.latencyMs = latencyMs;
      // labels are bounded sets (intent names, outcome words): never a user id
      this.metrics.inc('chat_requests_total', { intent: intentName, status });
      this.metrics.observe('chat_latency_ms', latencyMs, { intent: intentName });
      this.logger.log(JSON.stringify(log));
    }
    return { messages: messages.flatMap((m) => chunkMessage(m)), intent: intentName };
  }

  private reply(intent: IntentName, text: string): ChatReply {
    return { messages: chunkMessage(text), intent };
  }

  private async dispatch(ctx: HandlerContext): Promise<string[]> {
    const { intent } = ctx;

    // Request-size rules are explicit: tickers are never silently ignored or truncated.
    if (intent.symbols.length > this.maxSymbols) {
      ctx.log.symbolLimit = { requested: intent.symbols.length, max: this.maxSymbols };
      return [symbolLimitMessage(this.maxSymbols)];
    }
    if (SINGLE_SYMBOL_ONLY.has(intent.intent) && intent.symbols.length > 1) {
      return [SINGLE_SYMBOL_MESSAGE[intent.intent === 'ALERT_CREATE' ? 'alert' : 'question']];
    }

    if (intent.clarification && intent.intent !== 'ALERT_CREATE') return [intent.clarification];
    if (
      NEEDS_SYMBOL.has(intent.intent) &&
      intent.symbols.length === 0 &&
      intent.intent !== 'ALERT_CREATE' &&
      // advice-style wording with no ticker still gets the fixed policy answer
      intent.intent !== 'STOCK_ADVICE'
    ) {
      return [ASK_SYMBOL];
    }

    switch (intent.intent) {
      case 'HELP':
        return this.general.help();
      case 'SMALL_TALK':
        return this.general.smallTalk(ctx);
      case 'STOCK_QUOTE':
        return this.stock.quote(ctx);
      case 'STOCK_HISTORICAL':
        return this.stock.historical(ctx);
      case 'STOCK_TECHNICAL':
        return this.stock.technical(ctx);
      case 'STOCK_ANALYSIS':
        return this.stock.analyze(ctx);
      case 'STOCK_ADVICE':
        return this.stock.advice(ctx);
      case 'STOCK_QUESTION': {
        const answer = await this.stock.analyze(
          ctx,
          (intent.parameters.question as string) ?? intent.text,
        );
        // headlines as data, in their own message: source-grounded, never a causal claim
        return [...answer, ...(await this.stock.relatedNews(ctx))];
      }
      case 'STOCK_COMPARISON':
        return this.stock.compare(ctx);
      case 'STOCK_SCREEN':
        return this.stock.screen(ctx);
      case 'FOREIGN_FLOW':
        return this.stock.foreignFlow(ctx);
      case 'BROKER_SUMMARY':
        return this.stock.brokerSummary(ctx);
      case 'FUNDAMENTALS':
        return this.stock.fundamentals(ctx);
      case 'STOCK_NEWS':
        return this.stock.news(ctx);
      case 'MARKET_STATUS':
        return this.stock.marketStatus(ctx);
      case 'WATCHLIST_ADD':
        if (ctx.chat.type !== 'private') return [WATCHLIST_PRIVATE_ONLY];
        return this.lists.watchlistAdd(ctx);
      case 'WATCHLIST_REMOVE':
        if (ctx.chat.type !== 'private') return [WATCHLIST_PRIVATE_ONLY];
        return this.lists.watchlistRemove(ctx);
      case 'WATCHLIST_LIST':
        if (ctx.chat.type !== 'private') return [WATCHLIST_PRIVATE_ONLY];
        return this.lists.watchlistList(ctx);
      case 'ALERT_CREATE':
        return this.lists.alertCreate(ctx);
      case 'ALERT_LIST':
        return this.lists.alertList(ctx);
      case 'ALERT_DELETE':
        return this.lists.alertDelete(ctx);
      case 'ALERT_PAUSE':
        return this.lists.alertPause(ctx);
      case 'ALERT_RESUME':
        return this.lists.alertResume(ctx);
      case 'PORTFOLIO_RECORD':
      case 'PORTFOLIO_UNDO':
      case 'PORTFOLIO_VIEW':
      case 'PORTFOLIO_HISTORY':
      case 'PORTFOLIO_SUMMARY':
        // private data: never shown in, nor recorded from, a group (privacy)
        if (ctx.chat.type !== 'private') return [PORTFOLIO_PRIVATE_ONLY];
        if (intent.intent === 'PORTFOLIO_RECORD') return this.ledger.record(ctx);
        if (intent.intent === 'PORTFOLIO_UNDO') return this.ledger.undo(ctx);
        if (intent.intent === 'PORTFOLIO_HISTORY') return this.ledger.history(ctx);
        if (intent.intent === 'PORTFOLIO_SUMMARY') return this.stock.portfolioSummary(ctx);
        return this.ledger.view(ctx);
      case 'CONTEXT_RECALL':
      case 'CONTEXT_CLEAR':
      case 'PREFERENCE_VIEW':
      case 'PREFERENCE_SET':
      case 'PREFERENCE_CLEAR':
      case 'DATA_DELETE':
        // memory is personal: never shown, changed or erased from a group
        if (ctx.chat.type !== 'private') return [MEMORY_PRIVATE_ONLY];
        return this.memory.handle(ctx);
      case 'GENERAL_QUESTION':
        return this.knowledge.general(ctx);
      case 'NOTE_ADD':
      case 'NOTE_LIST':
      case 'NOTE_DELETE':
      case 'NOTE_SEARCH':
        // notes are personal: never shown, added or deleted from a group
        if (ctx.chat.type !== 'private') return [NOTES_PRIVATE_ONLY];
        if (intent.intent === 'NOTE_ADD') return this.knowledge.noteAdd(ctx);
        if (intent.intent === 'NOTE_LIST') return this.knowledge.noteList(ctx);
        if (intent.intent === 'NOTE_DELETE') return this.knowledge.noteDelete(ctx);
        return this.knowledge.noteSearch(ctx);
      case 'UNKNOWN':
      default:
        return (await this.knowledge.tryUnknown(ctx)) ?? this.general.unknown();
    }
  }

  /** Maps any error to a safe, friendly message. Internals go to logs only (scrubbed). */
  private toUserMessage(error: unknown, log: Record<string, unknown>): string {
    if (error instanceof UserFacingError) {
      log.errorCode = error.code;
      return error.userMessage;
    }
    const msg = safeErrorMessage(error);
    log.error = msg;
    const isDb = /prisma|database|ECONNREFUSED.*5\d{3}|P10\d\d|P20\d\d/i.test(msg);
    return isDb ? DB_ERROR : GENERIC_ERROR;
  }
}
