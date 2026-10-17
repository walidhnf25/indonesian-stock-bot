import {
  DEFAULT_MAX_RESPONSE_BYTES,
  readJsonBounded,
  readTextBounded,
  ResponseTooLargeError,
} from '../../common/utils/bounded-http';
import { safeErrorMessage } from '../../common/utils/scrub';
import { AIUnavailableError } from './ai-provider.interface';

/** An error body is only ever quoted (scrubbed, 200 chars); never read more than this much of it. */
const ERROR_BODY_PEEK_BYTES = 2048;

const isTimeout = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/**
 * fetch wrapper: timeout + consistent AIUnavailableError (never leaks URLs with keys) + a ceiling on the response
 * size. The ceiling is enforced while the body streams in, so an upstream that sends too much, sends
 * forever, or lies about its Content-Length cannot make the process buffer more than `maxBytes`. The deadline
 * (`timeoutMs`) covers the body as well: a server that drips bytes is cut off by it.
 */
export async function postJson(
  url: string,
  body: unknown,
  opts: {
    timeoutMs: number;
    headers?: Record<string, string>;
    label: string;
    /** Largest response body accepted. */
    maxBytes?: number;
  },
): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    const timedOut = isTimeout(e);
    throw new AIUnavailableError(
      timedOut
        ? `${opts.label} timed out after ${opts.timeoutMs}ms`
        : `${opts.label} unreachable: ${safeErrorMessage(e)}`,
      timedOut ? 'timeout' : 'unreachable',
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      // a short peek; the rest of a (possibly huge) error page is never read
      detail = (await readTextBounded(res, ERROR_BODY_PEEK_BYTES)).slice(0, 200);
    } catch (e) {
      if (e instanceof ResponseTooLargeError) detail = '(error body too large, not read)';
    }
    await res.body?.cancel().catch(() => undefined);
    throw new AIUnavailableError(
      `${opts.label} HTTP ${res.status}: ${safeErrorMessage(detail)}`,
      'bad_response',
    );
  }
  try {
    return await readJsonBounded(res, maxBytes);
  } catch (e) {
    if (e instanceof ResponseTooLargeError) {
      throw new AIUnavailableError(
        `${opts.label} response exceeds the ${maxBytes}-byte limit`,
        'bad_response',
      );
    }
    if (isTimeout(e)) {
      throw new AIUnavailableError(`${opts.label} timed out after ${opts.timeoutMs}ms`, 'timeout');
    }
    throw new AIUnavailableError(`${opts.label} returned non-JSON`, 'bad_response');
  }
}
