import type { Bot } from 'grammy';
import { Metrics } from '../common/metrics.service';
import type { UserFromGetMe } from 'grammy/types';
import { AccessService, UNAUTHORIZED_MESSAGE } from '../access/access.service';
import { ChatService } from '../chat/chat.service';
import { AppConfig } from '../config/app-config.service';
import { NotifierService } from '../notifier/notifier.service';
import { isTestRuntime } from './runtime-guard';
import { GROUP_BUDGET_PER_MINUTE, TelegramService } from './telegram.service';

/** A syntactically valid but FAKE token; the stubbed transport never talks to Telegram. */
const FAKE_TOKEN = ['123456', 'TEST-token-that-is-not-real-0000000000000'].join(':');
const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as UserFromGetMe;

interface Sent {
  method: string;
  payload: Record<string, unknown>;
}

function setup(allowed: number[], publicAccess = false) {
  const chat = {
    handle: jest.fn(async (_req: unknown) => ({ messages: ['balasan bot'], intent: 'UNKNOWN' })),
  };
  const access = new AccessService({
    allowedTelegramIds: new Set(allowed),
    publicAccess,
  } as unknown as AppConfig);
  const service = new TelegramService(
    { get: () => undefined } as unknown as AppConfig,
    chat as unknown as ChatService,
    {} as NotifierService,
    access,
    new Metrics(),
  );
  const bot: Bot = service.buildBot(FAKE_TOKEN, BOT_INFO);
  const sent: Sent[] = [];
  // Stub the Telegram HTTP API: record every call, never hit the network.
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === 'sendMessage'
        ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } }
        : true;
    return { ok: true, result } as never;
  });
  let updateId = 0;
  const textUpdate = (
    fromId: number | null,
    text: string,
    chat: { id: number; type: string } = { id: fromId ?? 1, type: 'private' },
  ) => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat,
      ...(fromId === null ? {} : { from: { id: fromId, is_bot: false, first_name: 'T' } }),
      text,
    },
  });
  const photoUpdate = (fromId: number) => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId, is_bot: false, first_name: 'T' },
      photo: [{ file_id: 'x', file_unique_id: 'y', width: 1, height: 1 }],
    },
  });
  const messagesSent = () =>
    sent.filter((s) => s.method === 'sendMessage').map((s) => String(s.payload.text));
  return { bot, service, chat, sent, access, textUpdate, photoUpdate, messagesSent };
}

describe('Telegram authorization middleware (the earliest boundary)', () => {
  it('lets an allowed user through to ChatService and delivers the reply', async () => {
    const t = setup([111]);
    await t.bot.handleUpdate(t.textUpdate(111, 'BBCA') as never);
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
    expect(t.chat.handle.mock.calls[0][0]).toMatchObject({ telegramId: 111, text: 'BBCA' });
    expect(t.messagesSent()).toEqual(['balasan bot']);
  });

  it('does NOT treat Telegram input as trusted: the transport never sets `trusted`', async () => {
    const t = setup([111]);
    await t.bot.handleUpdate(t.textUpdate(111, 'BBCA') as never);
    expect(t.chat.handle.mock.calls[0][0]).not.toHaveProperty('trusted');
  });

  it('supports several allowed users independently', async () => {
    const t = setup([111, 222]);
    await t.bot.handleUpdate(t.textUpdate(111, 'a') as never);
    await t.bot.handleUpdate(t.textUpdate(222, 'b') as never);
    await t.bot.handleUpdate(t.textUpdate(333, 'c') as never);
    expect(t.chat.handle).toHaveBeenCalledTimes(2);
  });

  it('stops an unauthorized user BEFORE ChatService (no intent detection, no AI, no DB) and says so once', async () => {
    const t = setup([111]);
    await t.bot.handleUpdate(t.textUpdate(999, 'analisis BBCA') as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.messagesSent()).toEqual([UNAUTHORIZED_MESSAGE]);
    // no "typing…" action either: nothing downstream ran
    expect(t.sent.some((s) => s.method === 'sendChatAction')).toBe(false);
  });

  it('throttles the rejection reply (no spam of the Telegram API by a stranger)', async () => {
    const t = setup([111]);
    for (let i = 0; i < 20; i++) await t.bot.handleUpdate(t.textUpdate(999, `spam ${i}`) as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.messagesSent()).toHaveLength(1);
  });

  it('rejects non-text messages from strangers with the same message (not the "text only" hint)', async () => {
    const t = setup([111]);
    await t.bot.handleUpdate(t.photoUpdate(999) as never);
    expect(t.messagesSent()).toEqual([UNAUTHORIZED_MESSAGE]);
  });

  it('stays silent for strangers in group chats and for updates without a sender', async () => {
    const t = setup([111]);
    await t.bot.handleUpdate(
      t.textUpdate(999, '/help', { id: -100123, type: 'supergroup' }) as never,
    );
    await t.bot.handleUpdate(t.textUpdate(null, 'halo') as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
  });

  it('FAILS CLOSED with an empty allowlist: everybody is rejected, including would-be owners', async () => {
    const t = setup([]);
    await t.bot.handleUpdate(t.textUpdate(111, 'BBCA') as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.messagesSent()).toEqual([UNAUTHORIZED_MESSAGE]);
  });

  it('PUBLIC mode: a user who is on no list reaches ChatService and gets the normal reply', async () => {
    const t = setup([], true);
    await t.bot.handleUpdate(t.textUpdate(999, 'BBCA') as never);
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
    expect(t.chat.handle.mock.calls[0][0]).toMatchObject({ telegramId: 999, text: 'BBCA' });
    expect(t.chat.handle.mock.calls[0][0]).not.toHaveProperty('trusted');
    expect(t.messagesSent()).toEqual(['balasan bot']);
  });

  it('PUBLIC mode still ignores updates that have no sender', async () => {
    const t = setup([], true);
    await t.bot.handleUpdate(t.textUpdate(null, 'halo') as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
  });

  it('answers allowed non-text messages with the text-only hint', async () => {
    const t = setup([111]);
    await t.bot.handleUpdate(t.photoUpdate(111) as never);
    expect(t.messagesSent()[0]).toMatch(/hanya bisa membaca pesan teks/);
  });

  it('a failing ChatService is contained: the runner hands the error to the bot error handler', async () => {
    const t = setup([111]);
    t.chat.handle.mockRejectedValueOnce(new Error('boom'));
    let caught: unknown;
    try {
      await t.bot.handleUpdate(t.textUpdate(111, 'BBCA') as never);
    } catch (e) {
      caught = e; // grammY surfaces middleware errors; @grammyjs/runner passes them to bot.errorHandler
    }
    expect(caught).toBeDefined();
    await expect(
      Promise.resolve().then(() => t.bot.errorHandler(caught as never)),
    ).resolves.toBeUndefined(); // logged, never thrown
  });
});

/**
 * a test/probe process must NEVER start real long polling. The hazard being modelled: the
 * validated (cached) config still holds a real-looking token and says NODE_ENV=development because
 * ConfigModule was imported before the harness neutralised the environment.
 */
describe('Telegram transport test boundary', () => {
  const FAKE = ['123456', 'FAKE-token-that-is-not-real-0000000000000'].join(':');
  const leakyConfig = (extra: Record<string, unknown> = {}) =>
    ({
      get: (k: string) =>
        ({ TELEGRAM_BOT_TOKEN: FAKE, NODE_ENV: 'development', TELEGRAM_ENABLED: true, ...extra })[
          k
        ],
    }) as unknown as AppConfig;
  const build = (config: AppConfig) =>
    new TelegramService(
      config,
      { handle: jest.fn() } as unknown as ChatService,
      { register: jest.fn() } as unknown as NotifierService,
      new AccessService({ allowedTelegramIds: new Set([1]) } as unknown as AppConfig),
      new Metrics(),
    );

  it('this process is recognised as a test runtime', () => {
    expect(isTestRuntime()).toBe(true);
    // Booleans only: never put the value itself in an assertion (a failure would print the secret).
    expect(Boolean(process.env.TELEGRAM_BOT_TOKEN)).toBe(false);
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('does not build a Bot, start polling or touch the network even if the cached config has a token', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('NETWORK ACCESS IN TEST');
    });
    const service = build(leakyConfig());
    const buildBot = jest.spyOn(service, 'buildBot');
    const start = jest.spyOn(service as unknown as { start: () => unknown }, 'start');

    await service.onModuleInit();

    expect(buildBot).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.health).toMatchObject({
      status: 'disabled',
      detail: 'dinonaktifkan di lingkungan test',
    });
    expect((service as unknown as { bot?: unknown }).bot).toBeUndefined();
    expect((service as unknown as { runner?: unknown }).runner).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('start() itself refuses to run in a test process (defence in depth)', async () => {
    const service = build(leakyConfig());
    await expect(
      (service as unknown as { start: (b: unknown) => Promise<void> }).start({}),
    ).rejects.toThrow('TELEGRAM_DISABLED_IN_TEST');
  });

  it('TELEGRAM_ENABLED=false is an explicit off switch even with a token (outside tests)', async () => {
    const original = process.env.NODE_ENV;
    const jestId = process.env.JEST_WORKER_ID;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JEST_WORKER_ID;
      const service = build(leakyConfig({ TELEGRAM_ENABLED: false, NODE_ENV: 'production' }));
      const buildBot = jest.spyOn(service, 'buildBot');
      await service.onModuleInit();
      expect(buildBot).not.toHaveBeenCalled();
      expect(service.health.detail).toMatch(/TELEGRAM_ENABLED=false/);
    } finally {
      process.env.NODE_ENV = original;
      if (jestId !== undefined) process.env.JEST_WORKER_ID = jestId;
    }
  });

  it('an empty token keeps Telegram disabled with the existing explanation', async () => {
    const service = build(leakyConfig({ TELEGRAM_BOT_TOKEN: undefined }));
    await service.onModuleInit();
    expect(service.health.detail).toMatch(/TELEGRAM_BOT_TOKEN/);
  });
});

describe('Telegram transport: identity and chat scope', () => {
  const user = (id: number) => ({ id, is_bot: false, first_name: 'T' });

  it('passes the real chat id and chat TYPE through, with the sender as the identity', async () => {
    const t = setup([], true);
    await t.bot.handleUpdate(t.textUpdate(111, 'BBCA') as never);
    await t.bot.handleUpdate(
      t.textUpdate(111, '/stock BBCA', { id: -100123, type: 'supergroup' }) as never,
    );
    expect(t.chat.handle.mock.calls[0][0]).toMatchObject({
      telegramId: 111,
      chatId: 111,
      chatType: 'private',
    });
    expect(t.chat.handle.mock.calls[1][0]).toMatchObject({
      telegramId: 111,
      chatId: -100123,
      chatType: 'supergroup',
    });
  });

  it('callback queries, edited messages, channel posts and inline queries reach no handler and send nothing', async () => {
    const t = setup([], true);
    const base = { update_id: 900 };
    await t.bot.handleUpdate({
      ...base,
      callback_query: { id: '1', from: user(111), chat_instance: 'x', data: 'buy' },
    } as never);
    await t.bot.handleUpdate({
      update_id: 901,
      edited_message: {
        message_id: 1,
        date: 1,
        chat: { id: 111, type: 'private' },
        from: user(111),
        text: 'BBCA',
      },
    } as never);
    await t.bot.handleUpdate({
      update_id: 902,
      channel_post: {
        message_id: 1,
        date: 1,
        chat: { id: -100999, type: 'channel', title: 'c' },
        text: 'BBCA',
      },
    } as never);
    await t.bot.handleUpdate({
      update_id: 903,
      inline_query: { id: '2', from: user(111), query: 'BBCA', offset: '' },
    } as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
  });

  it('a FORWARDED message is attributed to whoever sent it, never to the original author', async () => {
    const t = setup([], true);
    const update = {
      update_id: 910,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: 111, type: 'private' },
        from: user(111),
        forward_origin: { type: 'user', date: 1_699_999_000, sender_user: user(5) },
        text: 'ingatkan saya kalau BBCA di atas 8500',
      },
    };
    await t.bot.handleUpdate(update as never);
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
    expect(t.chat.handle.mock.calls[0][0]).toMatchObject({
      telegramId: 111,
      chatId: 111,
      chatType: 'private',
    });
    expect(JSON.stringify(t.chat.handle.mock.calls[0][0])).not.toContain('"telegramId":5');
  });

  it.each([
    ['GroupAnonymousBot (anonymous group admin)', 1087968824],
    ['Channel_Bot ("send as channel")', 136817688],
    ['the Telegram service account', 777000],
  ])(
    '%s shares one id between unrelated people, so it is ignored before any state is touched',
    async (_label, id) => {
      const t = setup([], true);
      await t.bot.handleUpdate(
        t.textUpdate(id, '/stock BBCA', {
          id: -100500,
          type: 'supergroup',
        }) as never,
      );
      expect(t.chat.handle).not.toHaveBeenCalled();
      expect(t.sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    },
  );

  it('a message sent on behalf of a chat (sender_chat) is ignored even with an ordinary-looking id', async () => {
    const t = setup([], true);
    const update = t.textUpdate(111, '/stock BBCA', {
      id: -100500,
      type: 'supergroup',
    }) as unknown as {
      message: Record<string, unknown>;
    };
    update.message.sender_chat = { id: -100777, type: 'channel', title: 'c' };
    await t.bot.handleUpdate(update as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
  });

  it('an ordinary member of the same group is still served (the guard is not a blanket group ban)', async () => {
    const t = setup([], true);
    await t.bot.handleUpdate(
      t.textUpdate(111, '/stock BBCA', { id: -100500, type: 'supergroup' }) as never,
    );
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
  });
});

describe('Telegram transport: who is being addressed in a group', () => {
  const GROUP = { id: -100500, type: 'supergroup' };
  /** Bot is "@test_bot" once started; the harness skips start(), so set what start() would set. */
  const started = () => {
    const t = setup([], true);
    (t.service as unknown as { botUsername: string }).botUsername = 'test_bot';
    return t;
  };

  it.each([
    '@test_bot harga BBCA',
    '@TEST_BOT harga BBCA',
    'harga BBCA @test_bot',
    'halo @test_bot, harga BBCA?',
    '@test_bot, harga BBCA',
    '(@test_bot) harga BBCA',
  ])('is a mention of this bot: %s', async (text) => {
    const t = started();
    await t.bot.handleUpdate(t.textUpdate(111, text, GROUP) as never);
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
    expect(String((t.chat.handle.mock.calls[0][0] as { text: string }).text)).not.toMatch(
      /@test_bot/i,
    ); // the handle is removed before parsing
  });

  it.each([
    '@test_bot2 harga BBCA', // another bot whose name starts the same way
    '@test_bot_ harga BBCA',
    'kirim ke x@test_bot.example harga BBCA', // an e-mail, not a mention
    'user@test_bot harga BBCA',
    '@other_bot harga BBCA',
    'harga BBCA',
  ])('is NOT a mention of this bot: %s', async (text) => {
    const t = started();
    await t.bot.handleUpdate(t.textUpdate(111, text, GROUP) as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
  });

  it.each([
    '/stock BBCA',
    '/stock@test_bot BBCA',
    '/STOCK@TEST_BOT BBCA',
    '/help',
    '/start@test_bot',
  ])('a command for this bot is answered: %s', async (text) => {
    const t = started();
    await t.bot.handleUpdate(t.textUpdate(111, text, GROUP) as never);
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
  });

  it.each([
    '/start@other_bot',
    '/help@other_bot',
    '/stock@some_other_bot BBCA',
    '/stock@test_bot2 BBCA',
  ])('a command aimed at ANOTHER bot is ignored: %s', async (text) => {
    const t = started();
    await t.bot.handleUpdate(t.textUpdate(111, text, GROUP) as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    expect(t.sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
  });

  it('the same rules hold in a private chat for commands aimed at another bot', async () => {
    const t = started();
    await t.bot.handleUpdate(t.textUpdate(111, '/stock@other_bot BBCA') as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    await t.bot.handleUpdate(t.textUpdate(111, 'BBCA') as never); // plain private text always works
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
  });

  it('before the bot knows its own username, targeted commands and mentions are ignored (fail closed)', async () => {
    const t = setup([], true); // botUsername unset
    await t.bot.handleUpdate(t.textUpdate(111, '/stock@test_bot BBCA', GROUP) as never);
    await t.bot.handleUpdate(t.textUpdate(111, '@test_bot BBCA', GROUP) as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
    await t.bot.handleUpdate(t.textUpdate(111, '/stock BBCA', GROUP) as never); // untargeted: fine
    expect(t.chat.handle).toHaveBeenCalledTimes(1);
  });

  it('a command-looking word later in the text does not make a group message addressed', async () => {
    const t = started();
    await t.bot.handleUpdate(t.textUpdate(111, 'lihat /stock BBCA ya', GROUP) as never);
    expect(t.chat.handle).not.toHaveBeenCalled();
  });
});

describe('one member cannot hold up the rest of a group', () => {
  const GROUP = { id: -1001, type: 'supergroup' };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function slowSetup() {
    const t = setup([], true);
    (t.service as unknown as { botUsername: string }).botUsername = 'test_bot';
    const finished: Array<{ user: number; text: string }> = [];
    t.chat.handle.mockImplementation(async (req: unknown) => {
      const r = req as { telegramId: number; text: string };
      if (r.text.includes('analisis')) await delay(400); // a slow AI generation
      finished.push({ user: r.telegramId, text: r.text });
      return { messages: ['ok'], intent: 'UNKNOWN' };
    });
    return { ...t, finished };
  }

  it('another member of the same group is answered while the first member is still being served', async () => {
    const t = slowSetup();
    const slow = t.bot.handleUpdate(
      t.textUpdate(11, '@test_bot analisis TSTA TSTB', GROUP) as never,
    );
    await delay(30);
    const started = Date.now();
    await t.bot.handleUpdate(t.textUpdate(22, '/help', GROUP) as never);
    expect(Date.now() - started).toBeLessThan(250); // did not wait for the 400 ms analysis
    expect(t.finished.map((f) => f.user)).toEqual([22]);
    await slow;
    expect(t.finished.map((f) => f.user)).toEqual([22, 11]);
  });

  it('the same member keeps the order of their own messages', async () => {
    const t = slowSetup();
    const first = t.bot.handleUpdate(t.textUpdate(11, '@test_bot analisis TSTA', GROUP) as never);
    await delay(30);
    const second = t.bot.handleUpdate(t.textUpdate(11, '/help', GROUP) as never);
    await Promise.all([first, second]);
    expect(t.finished.map((f) => f.text.trim())).toEqual(['analisis TSTA', '/help']);
  });

  it('a different group is never delayed either', async () => {
    const t = slowSetup();
    const slow = t.bot.handleUpdate(t.textUpdate(11, '@test_bot analisis TSTA', GROUP) as never);
    await delay(30);
    await t.bot.handleUpdate(t.textUpdate(33, '/help', { id: -1002, type: 'supergroup' }) as never);
    expect(t.finished.map((f) => f.user)).toEqual([33]);
    await slow;
  });
});

describe('a flood from one sender cannot occupy the bot', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('600 concurrent updates of one sender: only a few are ever served, others are dropped, nobody else waits', async () => {
    const t = setup([], true);
    let running = 0;
    let maxRunning = 0;
    let served = 0;
    t.chat.handle.mockImplementation(async (req: unknown) => {
      const r = req as { telegramId: number };
      if (r.telegramId === 9001) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        served++;
        await delay(300);
        running--;
      }
      return { messages: ['ok'], intent: 'UNKNOWN' };
    });
    const flood = Array.from({ length: 600 }, () =>
      t.bot.handleUpdate(t.textUpdate(9001, 'harga TSTA') as never),
    );
    await delay(30);
    const started = Date.now();
    await t.bot.handleUpdate(t.textUpdate(9002, '/help') as never);
    expect(Date.now() - started).toBeLessThan(200);
    await Promise.all(flood);
    expect(served).toBeLessThanOrEqual(3);
    expect(maxRunning).toBe(1); // a sender's own messages still run one at a time
  });

  it('tells a private-chat sender once that the earlier messages are still being processed', async () => {
    const t = setup([], true);
    t.chat.handle.mockImplementation(async () => {
      await delay(200);
      return { messages: ['ok'], intent: 'UNKNOWN' };
    });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        t.bot.handleUpdate(t.textUpdate(9003, 'harga TSTA') as never),
      ),
    );
    const notices = t.messagesSent().filter((m) => /masih diproses/.test(m));
    expect(notices).toHaveLength(1);
  });

  it('a group stays silent for dropped messages (no spam into the group)', async () => {
    const t = setup([], true);
    (t.service as unknown as { botUsername: string }).botUsername = 'test_bot';
    t.chat.handle.mockImplementation(async () => {
      await delay(200);
      return { messages: ['ok'], intent: 'UNKNOWN' };
    });
    const group = { id: -1001, type: 'supergroup' };
    await Promise.all(
      Array.from({ length: 20 }, () =>
        t.bot.handleUpdate(t.textUpdate(9004, '@test_bot harga TSTA', group) as never),
      ),
    );
    expect(t.messagesSent().filter((m) => /masih diproses/.test(m))).toHaveLength(0);
  });
});

describe('outgoing messages respect Telegram flood control', () => {
  const GROUP = { id: -1002, type: 'supergroup' };

  it('retryAfterSeconds reads Telegram 429 errors only', async () => {
    const { retryAfterSeconds } = await import('./telegram.service');
    expect(retryAfterSeconds({ error_code: 429, parameters: { retry_after: 3 } })).toBe(3);
    expect(retryAfterSeconds({ error_code: 429 })).toBe(1);
    expect(retryAfterSeconds({ error_code: 400 })).toBeNull();
    expect(retryAfterSeconds(new Error('x'))).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
  });

  it('a 429 is retried once after the requested wait, and the answer is delivered', async () => {
    const t = setup([], true);
    (t.service as unknown as { botUsername: string }).botUsername = 'test_bot';
    let calls = 0;
    t.bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendMessage' && ++calls === 1) {
        return {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 0',
          parameters: { retry_after: 0 },
        } as never;
      }
      return prev(method, payload, signal);
    });
    await t.bot.handleUpdate(t.textUpdate(11, '@test_bot harga TSTA', GROUP) as never);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(t.messagesSent()).toContain('balasan bot');
  });

  it('once a group has used its message budget, cosmetic messages are dropped but answers still go out', async () => {
    const t = setup([], true);
    (t.service as unknown as { botUsername: string }).botUsername = 'test_bot';
    let n = 0;
    t.chat.handle.mockImplementation(async (req: unknown) => {
      const r = req as { progress?: (m: string) => Promise<void> };
      await r.progress?.('⏳ Menganalisis <b>TSTA</b>…');
      n++;
      return { messages: [`jawaban ${n}`], intent: 'UNKNOWN' };
    });
    for (let i = 0; i < 12; i++) {
      await t.bot.handleUpdate(t.textUpdate(20 + i, '@test_bot analisis TSTA', GROUP) as never);
    }
    const sent = t.messagesSent();
    expect(sent.filter((m) => m.startsWith('jawaban'))).toHaveLength(12); // every answer delivered
    expect(sent.filter((m) => m.startsWith('⏳')).length).toBeLessThan(12); // some progress dropped
  });
});

describe('the SenderGate properties that no other test pinned', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const GROUP = { id: -1003, type: 'supergroup' };

  it('a handler that keeps throwing never uses up the sender slots (leave() runs in finally)', async () => {
    const t = setup([], true);
    t.chat.handle.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 8; i++) {
      // the runner hands the failure to the bot error handler; here it surfaces as a rejection
      await t.bot.handleUpdate(t.textUpdate(9100, 'harga TSTA') as never).catch(() => undefined);
    }
    // with 3 slots per sender, a leak would have started dropping messages after the third failure
    expect(t.chat.handle).toHaveBeenCalledTimes(8);
    expect(t.messagesSent().filter((m) => /masih diproses/.test(m))).toHaveLength(0);
  });

  it('in a group, one member holding all of their slots does not stop other members (the key includes the sender)', async () => {
    const t = setup([], true);
    (t.service as unknown as { botUsername: string }).botUsername = 'test_bot';
    const served: number[] = [];
    t.chat.handle.mockImplementation(async (req: unknown) => {
      const r = req as { telegramId: number };
      if (r.telegramId === 31) await delay(300);
      served.push(r.telegramId);
      return { messages: ['ok'], intent: 'UNKNOWN' };
    });
    const a = Array.from({ length: 6 }, () =>
      t.bot.handleUpdate(t.textUpdate(31, '@test_bot harga TSTA', GROUP) as never),
    );
    await delay(30);
    const started = Date.now();
    await t.bot.handleUpdate(t.textUpdate(32, '@test_bot harga TSTB', GROUP) as never);
    expect(served).toContain(32);
    expect(Date.now() - started).toBeLessThan(250);
    await Promise.all(a);
    expect(served.filter((id) => id === 31).length).toBeLessThanOrEqual(3);
  });
});

describe('one member cannot use up a group chat budget that belongs to everybody', () => {
  const GROUP = { id: -1004, type: 'supergroup' };
  const groupSetup = () => {
    const t = setup([], true);
    (t.service as unknown as { botUsername: string }).botUsername = 'test_bot';
    let n = 0;
    t.chat.handle.mockImplementation(async () => ({
      messages: [`jawaban ${++n}`],
      intent: 'UNKNOWN',
    }));
    return t;
  };

  it('a member who alone would use more than half the group budget gets their further answers dropped, with one notice', async () => {
    const t = groupSetup();
    for (let i = 0; i < 14; i++) {
      await t.bot.handleUpdate(t.textUpdate(51, '@test_bot harga TSTA', GROUP) as never);
    }
    const sent = t.messagesSent();
    const answers = sent.filter((m) => m.startsWith('jawaban'));
    expect(answers.length).toBe(Math.ceil(GROUP_BUDGET_PER_MINUTE / 2));
    expect(sent.filter((m) => /Terlalu banyak permintaan dari kamu/.test(m))).toHaveLength(1);
  });

  it('while that member is cut off, another member still gets every answer', async () => {
    const t = groupSetup();
    for (let i = 0; i < 12; i++) {
      await t.bot.handleUpdate(t.textUpdate(51, '@test_bot harga TSTA', GROUP) as never);
    }
    const before = t.messagesSent().length;
    for (let i = 0; i < 3; i++) {
      await t.bot.handleUpdate(t.textUpdate(52, '@test_bot harga TSTB', GROUP) as never);
    }
    expect(
      t
        .messagesSent()
        .slice(before)
        .filter((m) => m.startsWith('jawaban')),
    ).toHaveLength(3);
  });

  it('a real answer waits for a long retry_after (up to the bound) instead of being lost', async () => {
    const t = groupSetup();
    let calls = 0;
    t.bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendMessage' && ++calls === 1) {
        return {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 0',
          parameters: { retry_after: 0 },
        } as never;
      }
      return prev(method, payload, signal);
    });
    await t.bot.handleUpdate(t.textUpdate(53, '@test_bot harga TSTA', GROUP) as never);
    expect(t.messagesSent()).toContain('jawaban 1');
  });

  it('private chats have no per-sender group budget', async () => {
    const t = groupSetup();
    for (let i = 0; i < 20; i++) await t.bot.handleUpdate(t.textUpdate(54, 'harga TSTA') as never);
    expect(t.messagesSent().filter((m) => m.startsWith('jawaban'))).toHaveLength(20);
  });
});
