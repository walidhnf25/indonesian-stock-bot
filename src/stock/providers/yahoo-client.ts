import YahooFinance from 'yahoo-finance2';
import { boundedFetch } from '../../common/utils/bounded-http';
import { AppConfig } from '../../config/app-config.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_MAX_BYTES = 4_194_304;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The one place a `yahoo-finance2` client is built (quotes, history, fundamentals AND news use it). Its HTTP calls
 * go through `boundedFetch`: a deadline for the whole request and a ceiling on the response body, enforced while
 * the body streams in, so an upstream that sends too much cannot exhaust the process memory.
 */
export function createYahooClient(config?: AppConfig, fetchImpl?: typeof fetch): any {
  const maxBytes = config?.get('MARKET_DATA_MAX_RESPONSE_BYTES') ?? DEFAULT_MAX_BYTES;
  const timeoutMs = config?.get('MARKET_DATA_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
  return new (YahooFinance as any)({
    suppressNotices: ['yahooSurvey'],
    fetch: boundedFetch({ maxBytes, timeoutMs, fetchImpl }),
  });
}
