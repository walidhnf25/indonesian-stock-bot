/**
 * Reading an HTTP response with a ceiling on its size.
 *
 * `res.json()` / `res.text()` buffer the whole body: a hostile or misconfigured upstream that streams hundreds of
 * megabytes (or never stops) would take the process memory with it. Everything here counts the bytes while they
 * arrive and CANCELS the stream the moment the ceiling is crossed, so the process never holds more than
 * `maxBytes` (plus one chunk). A missing, wrong or compressed `Content-Length` therefore changes nothing: the
 * header is only a fast path, the counted bytes are the rule.
 */

/** Used when a caller passes no ceiling: far above any answer Indonesian Stock Bot expects, far below anything harmful. */
export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`response exceeds the ${limitBytes}-byte limit`);
    this.name = 'ResponseTooLargeError';
  }
}

const declaredLength = (res: Response): number | null => {
  const raw = res.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * The body as bytes, never more than `maxBytes`. Throws ResponseTooLargeError (after cancelling the stream) when
 * the limit is crossed; any other stream failure (abort, timeout, reset) propagates unchanged.
 */
export async function readBytesBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = declaredLength(res);
  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function readTextBounded(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBytesBounded(res, maxBytes));
}

/** Parsed JSON of a response of at most `maxBytes`; throws SyntaxError on malformed or truncated JSON. */
export async function readJsonBounded(res: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readTextBounded(res, maxBytes));
}

/**
 * A `fetch` for libraries that make their own HTTP calls (yahoo-finance2): one deadline for the whole exchange
 * including the body, and a ceiling on the body size enforced as the bytes stream in. The caller sees an ordinary
 * Response; if the limit is crossed its `json()`/`text()` rejects with ResponseTooLargeError.
 */
export function boundedFetch(opts: {
  maxBytes: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  const base: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    const deadline = AbortSignal.timeout(opts.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const res = await base(input, { ...init, signal });
    const declared = declaredLength(res);
    if (declared !== null && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(opts.maxBytes);
    }
    if (!res.body) return res;
    const source = res.body.getReader();
    let total = 0;
    const limited = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await source.read();
          if (done) return controller.close();
          total += value.byteLength;
          if (total > opts.maxBytes) {
            await source.cancel().catch(() => undefined);
            return controller.error(new ResponseTooLargeError(opts.maxBytes));
          }
          controller.enqueue(value);
        } catch (e) {
          controller.error(e);
        }
      },
      cancel: (reason) => source.cancel(reason).catch(() => undefined),
    });
    return new Response(limited, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
