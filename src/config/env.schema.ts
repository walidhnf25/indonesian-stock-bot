import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const intWithDefault = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);
/**
 * A switch that accepts true/false, 1/0, yes/no, on/off (any case). Anything else is an ERROR, never a
 * silent default: "TELEGRAM_ENABLED=0" used to leave Telegram enabled.
 */
const strictBoolean = (def: boolean) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const t = v.trim().toLowerCase();
      if (t === '') return undefined;
      if (TRUE_WORDS.has(t)) return true;
      if (FALSE_WORDS.has(t)) return false;
      return v;
    },
    z.boolean({ error: 'must be true/false (also 1/0, yes/no, on/off)' }).default(def),
  );

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** True for the addresses that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Telegram user IDs allowed to use the bot. Positive integers separated by commas/spaces.
 * An empty value is valid and means "nobody is allowed" (fail closed, see AccessService).
 */
export function parseAllowedUserIds(raw: string | undefined): { ids: number[]; invalid: string[] } {
  if (raw === undefined || raw.trim() === '') return { ids: [], invalid: [] };
  const ids: number[] = [];
  const invalid: string[] = [];
  raw
    .split(/[,;\s]+/)
    .filter((t) => t.length > 0)
    .forEach((token, i) => {
      // Telegram user IDs fit in 52 bits (16 digits); isSafeInteger rejects anything larger.
      const n = /^\d{1,16}$/.test(token) ? Number(token) : NaN;
      if (Number.isSafeInteger(n) && n > 0) {
        if (!ids.includes(n)) ids.push(n);
      } else {
        invalid.push(`entry #${i + 1}`);
      }
    });
  return { ids, invalid };
}

const allowedUserIds = z
  .preprocess(emptyToUndefined, z.string().optional())
  .transform((raw, ctx) => {
    const { ids, invalid } = parseAllowedUserIds(raw);
    if (invalid.length > 0) {
      // Never echo the raw value (it may contain a typo'd token); report positions only.
      ctx.addIssue({
        code: 'custom',
        message: `contains invalid ${invalid.join(', ')}; use positive integers separated by commas, e.g. 123456789,987654321`,
      });
      return z.NEVER;
    }
    return ids;
  });

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intWithDefault(3000, 1, 65535),
  /** REST API bind address. Must be a loopback address unless REST_ALLOW_REMOTE=true. */
  HOST: z.preprocess(emptyToUndefined, z.string().trim().min(1).default('127.0.0.1')),
  /**
   * The REST API has NO authentication. Binding it to a non-loopback address is refused at startup
   * unless this is set, which means "a firewall or authenticating reverse proxy protects it".
   */
  REST_ALLOW_REMOTE: strictBoolean(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TZ: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine(validTimeZone, 'must be a valid IANA time zone, e.g. Asia/Jakarta')
      .default('Asia/Jakarta'),
  ),

  /** Optional. Shared ephemeral state (quotas, locks, queues). Empty = in-process implementations. */
  REDIS_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:// or rediss://')
      .optional(),
  ),
  REDIS_CONNECT_TIMEOUT_MS: intWithDefault(2000, 100, 30_000),
  /**
   * Redis holds quotas and queued notifications; whoever can write to it can write jobs. A Redis on another host
   * must therefore require a password (put it in REDIS_URL: redis://:password@host:6379). Setting this to true
   * means "the network path to this Redis is private and trusted" and silences the startup refusal.
   */
  REDIS_ALLOW_UNAUTHENTICATED: strictBoolean(false),
  /**
   * all = one process does everything (default); gateway = Telegram + REST, no queue workers (needs Redis);
   * worker = queue workers + local REST, never Telegram polling.
   */
  BOT_ROLE: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim().toLowerCase()) : v),
    z.enum(['all', 'gateway', 'worker']).default('all'),
  ),
  /** Every Redis key starts with this, so one Redis can serve several apps. */
  REDIS_KEY_PREFIX: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[A-Za-z0-9_:-]{1,32}$/, 'REDIS_KEY_PREFIX: letters, digits, _ : - only (max 32)')
      .default('stockbot:'),
  ),

  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a PostgreSQL connection string'),

  TELEGRAM_BOT_TOKEN: optionalString,
  /** Master switch for the Telegram transport (false = REST/CLI only even when a token is set). */
  TELEGRAM_ENABLED: strictBoolean(true),
  TELEGRAM_ALLOWED_USER_IDS: allowedUserIds,
  /**
   * `allowlist` (default, fail closed): only TELEGRAM_ALLOWED_USER_IDS may use the bot.
   * `public`: every Telegram user may use it. Must be chosen explicitly; a missing or empty
   * allowlist never means "public".
   */
  TELEGRAM_ACCESS_MODE: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim().toLowerCase()) : v),
    z.enum(['allowlist', 'public']).default('allowlist'),
  ),

  STOCK_DATA_PROVIDER: z.enum(['yahoo']).default('yahoo'),
  STOCK_API_KEY: optionalString,
  SCREENER_EXTRA_SYMBOLS: optionalString,

  AI_PROVIDER: z.enum(['ollama', 'gemini', 'openai']).default('ollama'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: optionalString,
  /** Timeout of one analysis/answer generation. */
  AI_TIMEOUT_MS: intWithDefault(90000, 1000, 600_000),
  /** Largest model response accepted; the read is cancelled as soon as it is exceeded. */
  AI_MAX_RESPONSE_BYTES: intWithDefault(1_048_576, 4096, 67_108_864),
  /** Timeout of one AI intent classification (kept short: it is a fallback, not a feature). */
  AI_INTENT_TIMEOUT_MS: intWithDefault(10000, 1000, 120_000),
  /** Simultaneous generations (process-local). A local CPU model should stay at 1. */
  AI_MAX_CONCURRENT_REQUESTS: intWithDefault(1, 1, 16),
  /** Requests allowed to WAIT for a free slot; beyond this users get a "busy" reply. */
  AI_MAX_QUEUE_DEPTH: intWithDefault(3, 0, 100),
  /** Running slots one user may hold at once (fairness: one user cannot monopolise the model). */
  AI_MAX_CONCURRENT_PER_USER: intWithDefault(1, 1, 16),
  /** Waiting requests one user may have; more are answered "busy" immediately. */
  AI_MAX_QUEUE_PER_USER: intWithDefault(1, 0, 100),
  /** Longest question text (chars) forwarded to the model; the rest is cut off. */
  AI_QUESTION_MAX_CHARS: intWithDefault(300, 40, 4000),
  /** Longest a request may wait in the queue before it is answered with "busy". */
  AI_QUEUE_WAIT_TIMEOUT_MS: intWithDefault(60000, 1000, 600_000),
  AI_ANALYSIS_MAX_REQUESTS_PER_USER_PER_MINUTE: intWithDefault(5, 1, 1000),
  AI_INTENT_MAX_REQUESTS_PER_USER_PER_MINUTE: intWithDefault(10, 1, 1000),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,

  // Bounded above: timers longer than ~24 days overflow Node's 32-bit delay and would fire in a tight loop.
  ALERT_CHECK_INTERVAL_SECONDS: intWithDefault(120, 10, 3600),
  ALERT_CHECK_WHEN_CLOSED: strictBoolean(false),
  /** Days after creation after which an untriggered alert expires (forgotten alerts do not run forever). */
  ALERT_TTL_DAYS: intWithDefault(90, 1, 3650),
  MARKET_HOLIDAYS: optionalString,

  USER_RATE_LIMIT_PER_MINUTE: intWithDefault(20, 1, 10_000),
  /** Longest message (chars) Indonesian Stock Bot will process. Longer text is refused before any parsing/AI work. */
  MAX_INPUT_LENGTH: intWithDefault(1000, 50, 20_000),
  /** Retention (days) of rows that otherwise grow without bound. Active alerts are never deleted. */
  FETCH_LOG_RETENTION_DAYS: intWithDefault(7, 1, 3650),
  AI_ANALYSIS_RETENTION_DAYS: intWithDefault(30, 1, 3650),
  ALERT_HISTORY_RETENTION_DAYS: intWithDefault(30, 1, 3650),
  FUNDAMENTAL_SNAPSHOT_RETENTION_DAYS: intWithDefault(400, 30, 3650),
  /** Fundamentals served from a stored snapshot older than this are marked stale. */
  FUNDAMENTALS_STALE_DAYS: intWithDefault(7, 1, 365),
  /** Headline source; 'none' makes every news request honestly unavailable. */
  NEWS_PROVIDER: z.enum(['yahoo', 'none']).default('yahoo'),
  NEWS_MAX_AGE_DAYS: intWithDefault(14, 1, 365),
  NEWS_CACHE_TTL_SECONDS: intWithDefault(900, 60, 86_400),
  NEWS_RETENTION_DAYS: intWithDefault(90, 7, 3650),
  RETENTION_INTERVAL_HOURS: intWithDefault(6, 1, 168),
  /** How long (minutes) the per-chat conversation context (last tickers and lookups) is kept. */
  CONTEXT_TTL_MINUTES: intWithDefault(30, 1, 1440),
  /** Retrieval over the knowledge corpus and personal notes (needs the vector extension). */
  RAG_ENABLED: strictBoolean(true),
  EMBEDDING_PROVIDER: z.enum(['hashing', 'ollama']).default('hashing'),
  /** Ollama embedding model (e.g. nomic-embed-text); required when EMBEDDING_PROVIDER=ollama. */
  EMBEDDING_MODEL: optionalString,
  EMBEDDING_DIMENSIONS: intWithDefault(768, 8, 4096),
  EMBEDDING_TIMEOUT_MS: intWithDefault(20_000, 1000, 600_000),
  /** Largest embedding response accepted (a batch of vectors); beyond it the read is cancelled. */
  EMBEDDING_MAX_RESPONSE_BYTES: intWithDefault(8_388_608, 4096, 67_108_864),
  /** Percent: a chunk found only by the vector channel must be at least this similar to count. */
  RAG_MIN_SIMILARITY: intWithDefault(30, 0, 100),
  /** How far the quote's previous close may differ from the last stored daily close before it is suspect. */
  PRICE_REFERENCE_TOLERANCE_PERCENT: intWithDefault(5, 1, 100),
  /** Max tickers per message (analysis, comparison, watchlist...). Never silently truncated. */
  MAX_SYMBOLS_PER_REQUEST: intWithDefault(5, 1, 20),
  /** During trading hours a quote older than this (plus provider delay) is classified STALE. */
  MARKET_DATA_STALE_AFTER_MINUTES: intWithDefault(30, 1, 1440),
  /** A move larger than this vs the previous close is treated as suspicious unless corroborated. */
  PRICE_ANOMALY_MAX_CHANGE_PERCENT: intWithDefault(50, 10, 1000),
  QUOTE_CACHE_TTL_SECONDS: intWithDefault(60, 1, 86_400),
  HISTORY_CACHE_TTL_SECONDS: intWithDefault(900, 1, 86_400),
  STOCK_API_MAX_CONCURRENCY: intWithDefault(3, 1, 20),
  STOCK_API_MIN_INTERVAL_MS: intWithDefault(150, 0, 60_000),

  // --- Market-data governance: who may cause how many provider calls ---
  /** Distinct stocks one portfolio may hold at once. */
  PORTFOLIO_MAX_HOLDINGS: intWithDefault(50, 1, 500),
  /** Ledger rows one user may add per rolling 24 h (bookkeeping, not trading). */
  PORTFOLIO_MAX_TRANSACTIONS_PER_DAY: intWithDefault(100, 1, 10_000),
  /** Longest one chat request may keep provider calls queued/running; afterwards they are cancelled. */
  CHAT_REQUEST_DEADLINE_MS: intWithDefault(240_000, 5_000, 900_000),
  /** Provider calls one user may cause per minute that are NOT served from cache (each attempt counts). */
  MARKET_DATA_USER_UNCACHED_PER_MINUTE: intWithDefault(30, 1, 10_000),
  /** Provider calls one user may cause per hour (uncached; each attempt counts). Bounds what a few accounts can drain. */
  MARKET_DATA_USER_UNCACHED_PER_HOUR: intWithDefault(300, 1, 1_000_000),
  /**
   * Provider calls per hour in TOTAL (users + background jobs): the hard ceiling for the provider. It is split into
   * a pool for users and a reserve for system jobs (below), so the sum can never exceed it.
   */
  MARKET_DATA_GLOBAL_PER_HOUR: intWithDefault(10_000, 1, 1_000_000),
  /**
   * Part of MARKET_DATA_GLOBAL_PER_HOUR that only system jobs (alert evaluation) may spend; users can never take it.
   * Sizing: one alert cycle = 1 batch quote + 1 history per distinct alerted symbol (cached 15 min, so <= 4/h):
   * demand = cycles/h + 4 x symbols; 2 000 covers ~490 distinct symbols at the default 120 s interval.
   */
  MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: intWithDefault(2_000, 0, 1_000_000),
  /** Provider calls one user may have waiting for a slot (background jobs may queue up to the global bound). */
  MARKET_DATA_QUEUE_PER_USER: intWithDefault(5, 1, 100),
  /** Provider calls waiting for a slot in total (users); more are rejected at once (backpressure). */
  MARKET_DATA_QUEUE_GLOBAL: intWithDefault(200, 1, 10_000),
  /** Slots reserved for system jobs in the queue, on top of MARKET_DATA_QUEUE_GLOBAL (users cannot fill them). */
  MARKET_DATA_QUEUE_SYSTEM: intWithDefault(100, 1, 10_000),
  /** Longest a provider call waits for a slot. */
  MARKET_DATA_QUEUE_WAIT_MS: intWithDefault(15_000, 100, 120_000),
  /** Longest a provider call may run; its slot is released afterwards. */
  MARKET_DATA_TIMEOUT_MS: intWithDefault(20_000, 1000, 120_000),
  /** Largest market-data/news response accepted from the provider library's HTTP calls. */
  MARKET_DATA_MAX_RESPONSE_BYTES: intWithDefault(4_194_304, 4096, 67_108_864),
  /** Consecutive provider failures that open the circuit breaker. */
  MARKET_DATA_BREAKER_FAILURES: intWithDefault(5, 1, 100),
  /** How long the breaker stays open before one probe call. */
  MARKET_DATA_BREAKER_COOLDOWN_SECONDS: intWithDefault(30, 1, 3600),
  /** How long "this ticker exists" is remembered (listed tickers never need it). */
  TICKER_EXISTS_TTL_SECONDS: intWithDefault(86_400, 60, 604_800),
  /** How long "no such ticker" is remembered once it was confirmed by a second miss. */
  TICKER_MISSING_TTL_SECONDS: intWithDefault(120, 10, 3600),
});

/** Cross-field rules. Messages name the variable and never echo a secret. */
export const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.EMBEDDING_PROVIDER === 'ollama' && !env.EMBEDDING_MODEL) {
    ctx.addIssue({
      code: 'custom',
      path: ['EMBEDDING_MODEL'],
      message: 'is required when EMBEDDING_PROVIDER=ollama',
    });
  }
  if (env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['GEMINI_API_KEY'],
      message: 'is required when AI_PROVIDER=gemini',
    });
  }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['OPENAI_API_KEY'],
      message: 'is required when AI_PROVIDER=openai',
    });
  }
  if (env.BOT_ROLE === 'gateway' && !env.REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['BOT_ROLE'],
      message: 'gateway needs REDIS_URL: without queues nobody would evaluate alerts',
    });
  }
  if (env.MARKET_DATA_SYSTEM_RESERVE_PER_HOUR >= env.MARKET_DATA_GLOBAL_PER_HOUR) {
    ctx.addIssue({
      code: 'custom',
      path: ['MARKET_DATA_SYSTEM_RESERVE_PER_HOUR'],
      message:
        'must be smaller than MARKET_DATA_GLOBAL_PER_HOUR: users would have no provider budget at all',
    });
  }
  if (env.REDIS_URL && !env.REDIS_ALLOW_UNAUTHENTICATED) {
    let remoteWithoutPassword = false;
    try {
      const u = new URL(env.REDIS_URL);
      remoteWithoutPassword = !isLoopbackHost(u.hostname) && u.password === '';
    } catch {
      /* the regex above already rejected anything that is not a URL; a malformed one fails at connect time */
    }
    if (remoteWithoutPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message:
          'points to a non-loopback host without a password. Anyone who can reach that Redis could enqueue jobs and read quotas. Use redis://:password@host:port, or set REDIS_ALLOW_UNAUTHENTICATED=true if the path is private and trusted.',
      });
    }
  }
  if (!isLoopbackHost(env.HOST) && !env.REST_ALLOW_REMOTE) {
    ctx.addIssue({
      code: 'custom',
      path: ['HOST'],
      message: `"${env.HOST}" is not a loopback address, but the REST API has no authentication. Use 127.0.0.1, or set REST_ALLOW_REMOTE=true only behind a firewall or an authenticating reverse proxy.`,
    });
  }
});

export type Env = z.infer<typeof baseSchema>;

/** Validates raw process.env. Throws a readable error (never echoing secret values). */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
