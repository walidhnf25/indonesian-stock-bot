/**
 * Jest `setupFiles`: runs before any test module is imported, so ConfigModule (which validates
 * process.env when src/config/config.module.ts is first imported) sees test settings, and the
 * development database in .env is never used.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5436/ai_stock_test';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
// Tests may run with REDIS_URL set (Redis mode): their keys are isolated by this prefix and wiped per app.
process.env.REDIS_KEY_PREFIX = 'stockbottest:';
process.env.QUOTE_CACHE_TTL_SECONDS = '1';
process.env.HISTORY_CACHE_TTL_SECONDS = '1';
process.env.STOCK_API_MIN_INTERVAL_MS = '0';
process.env.ALERT_CHECK_WHEN_CLOSED = 'true';
process.env.SCREENER_EXTRA_SYMBOLS = 'TSTA,TSTB,TSTC';
process.env.USER_RATE_LIMIT_PER_MINUTE = '20';
// Generous market-data limits: tests that exercise the governance lower them explicitly (see MarketDataGovernor.reconfigure).
process.env.MARKET_DATA_USER_UNCACHED_PER_MINUTE = '10000';
process.env.MARKET_DATA_USER_UNCACHED_PER_HOUR = '1000000';
process.env.MARKET_DATA_GLOBAL_PER_HOUR = '1000000';
process.env.MARKET_DATA_QUEUE_PER_USER = '100';
process.env.MARKET_DATA_QUEUE_GLOBAL = '10000';
// Tests force provider failures on purpose; an open breaker would leak into the next test. Breaker tests use reconfigure().
process.env.MARKET_DATA_BREAKER_FAILURES = '100';
