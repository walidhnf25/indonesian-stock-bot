// MUST stay the first import. It neutralises the process environment (no Telegram token, test
// database, NODE_ENV=test) BEFORE ConfigModule validates and caches the environment when the app
// modules below are imported. Under Jest `setupFiles` already did this; the explicit import makes the
// guarantee hold for any other harness (ts-node probes, scripts) so a developer's real `.env` bot
// token can never start real long polling from a test run.
import './env';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessModule } from '../../src/access/access.module';
import { AccessService } from '../../src/access/access.service';
import { AI_PROVIDER } from '../../src/ai/providers/ai-provider.interface';
import { AlertModule } from '../../src/alert/alert.module';
import { AnalysisService } from '../../src/analysis/analysis.service';
import { ApiModule } from '../../src/api/api.module';
import { AppExceptionFilter } from '../../src/common/exceptions/app-exception.filter';
import { BackgroundTasks, CommonModule } from '../../src/common/background-tasks.service';
import { assertSafeTestDatabase } from '../../src/testing/db-guard';
import { configureHttp } from '../../src/common/http-setup';
import { AppConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { QueueModule } from '../../src/queue/queue.module';
import { RedisModule } from '../../src/redis/redis.module';
import { RedisService } from '../../src/redis/redis.service';
import { PrismaService } from '../../src/database/prisma.service';
import { NotifierModule } from '../../src/notifier/notifier.module';
import { NotifierService } from '../../src/notifier/notifier.service';
import { SchedulerModule } from '../../src/scheduler/scheduler.module';
import { HealthController } from '../../src/health/health.controller';
import { STOCK_DATA_PROVIDER } from '../../src/stock/stock-data-provider.interface';
import { NEWS_PROVIDER } from '../../src/news/news-provider.interface';
import { Metrics } from '../../src/common/metrics.service';
import { MarketDataGovernor } from '../../src/stock/governance/market-data-governor';
import { TickerRegistry } from '../../src/stock/governance/ticker-registry';
import { StockService } from '../../src/stock/stock.service';
import { TelegramModule } from '../../src/telegram/telegram.module';
import {
  DEFAULT_FIXTURE_STOCKS,
  FakeAIProvider,
  FakeNewsProvider,
  FakeStockProvider,
  FixtureStock,
} from '../../src/testing/fixtures';
import { TEST_DATABASE_URL } from './global-setup';

/** Same composition as AppModule minus pino (quiet tests) — scheduler stays off under NODE_ENV=test. */
@Module({
  imports: [
    AppConfigModule,
    RedisModule,
    QueueModule,
    CommonModule,
    AccessModule,
    DatabaseModule,
    NotifierModule,
    AlertModule,
    TelegramModule,
    SchedulerModule,
    ApiModule,
  ],
})
class TestAppModule {}

/** Tests that are not about authorization run with an open allowlist; security tests pass their own. */
const ALLOW_ALL = {
  isAllowed: () => true,
  isConfigured: true,
  noteRejection: () => ({ shouldLog: false, shouldReply: false }),
} as unknown as AccessService;

export interface TestAppOptions {
  /** AccessService replacement; defaults to "everyone allowed". Pass a real AccessService to test the allowlist. */
  access?: AccessService;
  /** Overrides for AIService options (queue depth, timeouts...). */
}

export interface TestApp {
  app: INestApplication;
  moduleRef: TestingModule;
  prisma: PrismaService;
  provider: FakeStockProvider;
  ai: FakeAIProvider;
  news: FakeNewsProvider;
  /** Messages the notifier would have delivered to Telegram. */
  sent: Array<{ chatId: number; text: string }>;
  failNotifications: { value: boolean; permanent?: boolean };
  close: () => Promise<void>;
}

export function configureTestEnv(extra: Record<string, string> = {}): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    TELEGRAM_BOT_TOKEN: '',
    LOG_LEVEL: 'silent',
    QUOTE_CACHE_TTL_SECONDS: '1',
    HISTORY_CACHE_TTL_SECONDS: '1',
    STOCK_API_MIN_INTERVAL_MS: '0',
    ALERT_CHECK_WHEN_CLOSED: 'true',
    SCREENER_EXTRA_SYMBOLS: 'TSTA,TSTB,TSTC',
    ...extra,
  });
}

/**
 * NOTE: `env` reaches process.env only AFTER the ConfigModule validated it (at import time, cached), so it
 * cannot change validated keys such as AI_TIMEOUT_MS or MARKET_DATA_*. Tests change limits on the services
 * instead: MarketDataGovernor.reconfigure(), AIService opts, AlertService config (see security.spec).
 */
export async function createTestApp(
  stocks: FixtureStock[] = DEFAULT_FIXTURE_STOCKS,
  env: Record<string, string> = {},
  options: TestAppOptions = {},
): Promise<TestApp> {
  configureTestEnv(env);
  const provider = new FakeStockProvider(stocks);
  const ai = new FakeAIProvider();
  const news = new FakeNewsProvider();

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] })
    .overrideProvider(STOCK_DATA_PROVIDER)
    .useValue(provider)
    .overrideProvider(AI_PROVIDER)
    .useValue(ai)
    .overrideProvider(NEWS_PROVIDER)
    .useValue(news)
    .overrideProvider(AccessService)
    .useValue(options.access ?? ALLOW_ALL)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AppExceptionFilter());
  configureHttp(app, { allowRemote: false }); // same HTTP rules as main.ts
  await app.init();

  const sent: TestApp['sent'] = [];
  const failNotifications: { value: boolean; permanent?: boolean } = { value: false };
  app.get(NotifierService).register(async (chatId, text) => {
    if (failNotifications.value) {
      throw failNotifications.permanent
        ? Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 })
        : new Error('telegram down');
    }
    sent.push({ chatId, text });
  });

  const prisma = app.get(PrismaService);
  await truncateAll(prisma);
  await flushTestRedis(app);

  return {
    app,
    moduleRef,
    prisma,
    provider,
    ai,
    news,
    sent,
    failNotifications,
    close: async () => {
      await app.close();
    },
  };
}

export async function truncateAll(prisma: PrismaService): Promise<void> {
  assertSafeTestDatabase(process.env.DATABASE_URL); // host must be local AND the name a test database
  await prisma.$executeRawUnsafe(
    'TRUNCATE "User","Stock","StockQuoteSnapshot","StockDailyPrice","TechnicalIndicator","Watchlist","WatchlistItem","Alert","AIAnalysis","ConversationContext","DataFetchLog" RESTART IDENTITY CASCADE',
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Empties the in-memory quote/history caches (what waiting for their 1 s TTL used to do, without the wait
 * and without depending on how fast the machine is). `health: true` also drops the 15 s /health probe cache.
 */
export function resetCaches(
  t: { app: INestApplication },
  opts: { health?: boolean; governance?: boolean } = {},
): void {
  const clear = (target: object, names: string[]) => {
    for (const name of names) {
      const cache = (target as Record<string, { clear?: () => void } | undefined>)[name];
      // a renamed or removed cache must fail loudly: a silent no-op would make later assertions meaningless
      if (typeof cache?.clear !== 'function') {
        throw new Error(`resetCaches: ${target.constructor.name}.${name} is not a cache any more`);
      }
      cache.clear();
    }
  };
  clear(t.app.get(StockService), ['quoteCache', 'historyCache', 'miscCache']);
  clear(t.app.get(AnalysisService), ['cache']); // technical reports (60 s) would otherwise outlive a fixture change
  t.app.get(TickerRegistry).reset(); // what was learned about tickers is a cache too
  if (opts.governance) {
    // also forget quotas, the breaker and the metrics (the governance tests keep them on purpose)
    t.app.get(MarketDataGovernor).resetState();
    t.app.get(Metrics).reset();
  }
  if (opts.health) clear(t.app.get(HealthController), ['cache']);
}

/** Waits for fire-and-forget work (snapshot persistence...) to finish: deterministic, unlike sleeping. */
export async function flushBackground(t: { app: INestApplication }): Promise<void> {
  await t.app.get(BackgroundTasks).flush();
}

/**
 * Waits until an observable condition holds (polling), instead of sleeping a guessed time. A fixed sleep is a bet on
 * machine speed; this fails only if the condition really never becomes true.
 */
export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await sleep(5);
  }
}

/**
 * Redis mode (REDIS_URL set): quotas and queues persist across apps and test files, unlike the in-process
 * stores. Like TRUNCATE for PostgreSQL, every test app starts from an empty keyspace of the TEST prefix only.
 */
export async function flushTestRedis(app: INestApplication): Promise<void> {
  const redis = app.get(RedisService);
  if (!redis.enabled) return;
  const prefix = redis.prefix;
  if (!/test/i.test(prefix))
    throw new Error(`Refusing to flush Redis keys under non-test prefix "${prefix}"`);
  const deadline = Date.now() + 3000;
  while (!redis.get() && Date.now() < deadline) await sleep(25);
  const client = redis.get();
  if (!client) return; // unreachable: the app runs on its in-process fallbacks anyway
  const keys = await client.keys(`${prefix}*`);
  if (keys.length) await client.del(...keys);
}
