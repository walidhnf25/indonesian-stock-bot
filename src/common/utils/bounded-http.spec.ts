import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { AIUnavailableError } from '../../ai/providers/ai-provider.interface';
import { postJson } from '../../ai/providers/http';
import { OllamaProvider } from '../../ai/providers/ollama.provider';
import { EmbeddingUnavailableError, OllamaEmbeddingProvider } from '../../rag/embedding.provider';
import { createYahooClient } from '../../stock/providers/yahoo-client';
import { classifyYahooError } from '../../stock/providers/yahoo.provider';
import {
  boundedFetch,
  DEFAULT_MAX_RESPONSE_BYTES,
  readBytesBounded,
  readJsonBounded,
  ResponseTooLargeError,
} from './bounded-http';

/**
 * A response body used to be buffered whole (`res.json()`): a hostile or misconfigured upstream streaming
 * 400 MB made the process grow by 1.7 GB. Every test below talks to a REAL local HTTP server (never an external
 * endpoint) and checks the bound on what the process reads, not only the error that comes out.
 */
const MB = 1024 * 1024;
// credentials in these tests are fake and assembled at runtime, so no source line looks like a real secret
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
const FAKE_BEARER = ['abcdefghijklmnopqrstuvwxyz', '0123456789'].join('');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe {
  /** bytes the server managed to write into the socket */
  sent: number;
  /** the client went away (connection released) */
  closed: boolean;
  requests: number;
}

type Handler = (req: IncomingMessage, res: ServerResponse, probe: Probe) => void;

describe('bounded HTTP responses', () => {
  let server: Server;
  let base: string;
  let handler: Handler;
  let probe: Probe;

  beforeAll(async () => {
    server = createServer((req, res) => {
      probe.requests++;
      res.on('close', () => (probe.closed = true));
      req.resume();
      handler(req, res, probe);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  beforeEach(() => {
    probe = { sent: 0, closed: false, requests: 0 };
    handler = (_req, res) => res.end('{}');
  });

  /** Writes `total` bytes (honouring back-pressure) of the JSON string {"p":"AAAA…"} in 64 KiB pieces. */
  const streamJson = (
    res: ServerResponse,
    p: Probe,
    total: number,
    headers: Record<string, string | number> = {},
  ) => {
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
    }
    const head = Buffer.from('{"p":"');
    const tail = Buffer.from('"}');
    const body = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    const write = (b: Buffer): boolean => {
      sent += b.length;
      p.sent = sent;
      return res.write(b);
    };
    write(head);
    const pump = () => {
      while (sent < total - tail.length && !res.destroyed) {
        const n = Math.min(body.length, total - tail.length - sent);
        if (!write(n === body.length ? body : body.subarray(0, n))) {
          res.once('drain', pump);
          return;
        }
      }
      if (!res.destroyed) res.end(tail);
    };
    pump();
  };
  const jsonOfSize = (bytes: number) => JSON.stringify({ p: 'x'.repeat(bytes - 8) });

  describe('readBytesBounded / readJsonBounded', () => {
    it('reads a response below the limit', async () => {
      handler = (_r, res) => res.end(JSON.stringify({ ok: true }));
      const res = await fetch(base);
      await expect(readJsonBounded(res, 1024)).resolves.toEqual({ ok: true });
    });

    it('accepts a body of exactly the limit and refuses one byte more', async () => {
      handler = (_r, res) => res.end(jsonOfSize(1000));
      const exact = await readBytesBounded(await fetch(base), 1000);
      expect(exact.byteLength).toBe(1000);
      handler = (_r, res) => res.end(jsonOfSize(1001));
      await expect(readBytesBounded(await fetch(base), 1000)).rejects.toBeInstanceOf(
        ResponseTooLargeError,
      );
    });

    it('rejects from Content-Length alone, without reading the body', async () => {
      handler = (_r, res, p) => streamJson(res, p, 50 * MB, { 'content-length': 50 * MB });
      const res = await fetch(base);
      await expect(readBytesBounded(res, 1 * MB)).rejects.toBeInstanceOf(ResponseTooLargeError);
      await delay(150);
      expect(probe.sent).toBeLessThan(16 * MB); // far below the 50 MB on offer
    });

    it('does not trust a missing Content-Length: a chunked body is counted and cut off', async () => {
      handler = (_r, res, p) => streamJson(res, p, 300 * MB); // no content-length => chunked
      const rssBefore = process.memoryUsage().rss;
      const res = await fetch(base);
      expect(res.headers.get('content-length')).toBeNull();
      await expect(readBytesBounded(res, 1 * MB)).rejects.toBeInstanceOf(ResponseTooLargeError);
      await delay(200);
      expect(probe.sent).toBeLessThan(40 * MB); // 300 MB offered; only socket buffers were filled
      expect(probe.closed).toBe(true); // the connection was released, not left streaming
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(120 * MB);
    }, 30_000);

    it('an infinite stream is cut off at the limit', async () => {
      handler = (_r, res, p) => streamJson(res, p, Number.MAX_SAFE_INTEGER);
      const res = await fetch(base);
      await expect(readBytesBounded(res, 512 * 1024)).rejects.toBeInstanceOf(ResponseTooLargeError);
      await delay(200);
      expect(probe.closed).toBe(true);
    }, 30_000);

    it('a declared length SMALLER than the real body cannot make the reader exceed the limit', async () => {
      // the HTTP parser stops at the declared length; whatever the server keeps sending is never delivered
      handler = (_r, res, p) => streamJson(res, p, 20 * MB, { 'content-length': 100 });
      const res = await fetch(base).catch(() => null);
      if (res) {
        const bytes = await readBytesBounded(res, 1 * MB).catch((e) => e);
        if (bytes instanceof Uint8Array) expect(bytes.byteLength).toBeLessThanOrEqual(1 * MB);
        else expect(bytes).toBeInstanceOf(Error);
      }
    });

    it('malformed JSON and a truncated stream are errors, not hangs', async () => {
      handler = (_r, res) => res.end('{"unterminated": ');
      await expect(readJsonBounded(await fetch(base), 1024)).rejects.toBeInstanceOf(SyntaxError);
      handler = (_r, res) => {
        res.writeHead(200, { 'content-length': 1000 });
        res.write('{"p":"abc');
        setTimeout(() => res.destroy(), 30);
      };
      // a network-level TypeError (from undici's realm), whatever its exact class
      await expect(fetch(base).then((r) => readJsonBounded(r, 1024))).rejects.toBeTruthy();
    });

    it('an empty body is empty, not an error of the reader', async () => {
      handler = (_r, res) => res.end();
      expect((await readBytesBounded(await fetch(base), 1024)).byteLength).toBe(0);
    });

    it('cancellation while reading releases the stream (the source sees cancel and stops producing)', async () => {
      let produced = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          produced++;
          controller.enqueue(new Uint8Array(64 * 1024));
          await delay(1);
        },
        cancel() {
          cancelled = true;
        },
      });
      await expect(readBytesBounded(new Response(body), 256 * 1024)).rejects.toBeInstanceOf(
        ResponseTooLargeError,
      );
      expect(cancelled).toBe(true);
      const at = produced;
      await delay(50);
      expect(produced).toBe(at); // nothing more is produced after the cancel
      expect(at).toBeLessThanOrEqual(8); // ~256 KiB / 64 KiB + read-ahead, never the whole stream
    });
  });

  describe('postJson (Ollama / Gemini / OpenAI)', () => {
    const post = (maxBytes: number, timeoutMs = 3000) =>
      postJson(`${base}/x`, { a: 1 }, { timeoutMs, label: 'Test', maxBytes });
    const failure = async (p: Promise<unknown>) =>
      (await p.then(
        () => null,
        (e) => e,
      )) as AIUnavailableError;

    it('returns a response below the limit', async () => {
      handler = (_r, res) => res.end(JSON.stringify({ message: { content: 'hai' } }));
      await expect(post(1024)).resolves.toEqual({ message: { content: 'hai' } });
    });

    it('turns an oversized response into a typed AIUnavailableError(bad_response) and stops reading', async () => {
      handler = (_r, res, p) => streamJson(res, p, 300 * MB);
      const rssBefore = process.memoryUsage().rss;
      const e = await failure(post(1 * MB));
      expect(e).toBeInstanceOf(AIUnavailableError);
      expect(e.kind).toBe('bad_response');
      expect(e.message).toMatch(/exceeds the 1048576-byte limit/);
      await delay(200);
      expect(probe.sent).toBeLessThan(40 * MB);
      expect(probe.closed).toBe(true);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(120 * MB);
    }, 30_000);

    it('applies the default ceiling when the caller passes none', async () => {
      handler = (_r, res, p) => streamJson(res, p, DEFAULT_MAX_RESPONSE_BYTES * 20);
      const e = await failure(postJson(`${base}/x`, {}, { timeoutMs: 3000, label: 'Test' }));
      expect(e.kind).toBe('bad_response');
    }, 30_000);

    it('cuts off a server that drips bytes forever at the deadline (slow / never-ending response)', async () => {
      handler = (_r, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const timer = setInterval(() => res.write(' '), 50);
        res.on('close', () => clearInterval(timer));
      };
      const started = Date.now();
      const e = await failure(post(1 * MB, 600));
      expect(e).toBeInstanceOf(AIUnavailableError);
      expect(['timeout', 'bad_response']).toContain(e.kind);
      expect(Date.now() - started).toBeLessThan(3000);
      await delay(100);
      expect(probe.closed).toBe(true);
    });

    it('a slow but complete answer inside the deadline is accepted', async () => {
      handler = (_r, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"message":');
        setTimeout(() => res.end('{"content":"pelan"}}'), 150);
      };
      await expect(post(1024)).resolves.toEqual({ message: { content: 'pelan' } });
    });

    it('malformed JSON -> bad_response', async () => {
      handler = (_r, res) => res.end('not json {{{');
      expect((await failure(post(1024))).kind).toBe('bad_response');
    });

    it('HTTP 500 with a sensitive-looking body: the key is not echoed and a huge error page is not read', async () => {
      handler = (_r, res, p) => {
        res.writeHead(500);
        res.write(`boom api_key=${FAKE_KEY} Bearer ${FAKE_BEARER} `);
        streamJson(res, p, 100 * MB); // continues with a flood
      };
      const e = await failure(post(1 * MB));
      expect(e.kind).toBe('bad_response');
      expect(e.message).toMatch(/HTTP 500/);
      expect(e.message).not.toMatch(new RegExp(`${FAKE_KEY}|${FAKE_BEARER}`));
      await delay(150);
      expect(probe.sent).toBeLessThan(40 * MB);
    }, 30_000);

    it('a connection that dies in the middle of the body -> typed failure', async () => {
      handler = (_r, res) => {
        res.writeHead(200, { 'content-length': 1000 });
        res.write('{"message":');
        setTimeout(() => res.destroy(), 30);
      };
      const e = await failure(post(1024));
      expect(e).toBeInstanceOf(AIUnavailableError);
    });
  });

  describe('OllamaProvider', () => {
    const provider = (maxResponseBytes: number) =>
      new OllamaProvider({ baseUrl: base, model: 'm', timeoutMs: 3000, maxResponseBytes });

    it('generate(): a valid answer below the limit works', async () => {
      handler = (_r, res) =>
        res.end(JSON.stringify({ message: { content: '{"observations":["O1"],"risks":[]}' } }));
      await expect(
        provider(64 * 1024).generate({ system: 's', prompt: 'p', json: true }),
      ).resolves.toContain('observations');
    });

    it('generate(): the hostile 400 MB answer of the audit ends in a typed failure with bounded memory', async () => {
      handler = (_r, res, p) => streamJson(res, p, 400 * MB);
      const rssBefore = process.memoryUsage().rss;
      const e = await provider(1 * MB)
        .generate({ system: 's', prompt: 'p' })
        .then(
          () => null,
          (err) => err as AIUnavailableError,
        );
      expect(e).toBeInstanceOf(AIUnavailableError);
      expect((e as AIUnavailableError).kind).toBe('bad_response');
      await delay(200);
      expect(probe.sent).toBeLessThan(40 * MB);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(120 * MB); // the audit saw +1 678 MB
    }, 30_000);

    it('checkHealth(): an oversized /api/tags answer is "unavailable", never a crash', async () => {
      handler = (_r, res, p) => streamJson(res, p, 100 * MB);
      const health = await provider(64 * 1024).checkHealth();
      expect(health.available).toBe(false);
      await delay(150);
      expect(probe.sent).toBeLessThan(40 * MB);
    }, 30_000);
  });

  describe('OllamaEmbeddingProvider', () => {
    it('an oversized /api/embed answer is EmbeddingUnavailable, bounded in memory', async () => {
      handler = (_r, res, p) => streamJson(res, p, 200 * MB);
      const provider = new OllamaEmbeddingProvider({
        baseUrl: base,
        model: 'e',
        dimensions: 8,
        timeoutMs: 3000,
        maxResponseBytes: 256 * 1024,
      });
      const rssBefore = process.memoryUsage().rss;
      const e = await provider.embed(['halo']).then(
        () => null,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(EmbeddingUnavailableError);
      expect((e as Error).message).toMatch(/too large/);
      await delay(200);
      expect(probe.sent).toBeLessThan(40 * MB);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(120 * MB);
    }, 30_000);
  });

  describe('boundedFetch (Yahoo / news client)', () => {
    const bounded = (maxBytes: number, timeoutMs = 2000) => boundedFetch({ maxBytes, timeoutMs });

    it('passes a normal response through unchanged', async () => {
      handler = (_r, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'yes' });
        res.end(JSON.stringify({ quote: 1 }));
      };
      const res = await bounded(1024)(base);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-test')).toBe('yes');
      await expect(res.json()).resolves.toEqual({ quote: 1 });
    });

    it('rejects an oversized Content-Length before any body is read', async () => {
      handler = (_r, res, p) => streamJson(res, p, 50 * MB, { 'content-length': 50 * MB });
      await expect(bounded(1 * MB)(base)).rejects.toBeInstanceOf(ResponseTooLargeError);
    }, 30_000);

    it('cuts a chunked oversized stream: the consumer sees ResponseTooLargeError, the socket is released', async () => {
      handler = (_r, res, p) => streamJson(res, p, 300 * MB);
      const res = await bounded(1 * MB)(base);
      await expect(res.json()).rejects.toBeInstanceOf(ResponseTooLargeError);
      await delay(200);
      expect(probe.sent).toBeLessThan(40 * MB);
      expect(probe.closed).toBe(true);
    }, 30_000);

    it('has one deadline for the whole exchange, body included', async () => {
      handler = (_r, res) => {
        res.writeHead(200);
        const timer = setInterval(() => res.write(' '), 40);
        res.on('close', () => clearInterval(timer));
      };
      const res = await bounded(1 * MB, 400)(base);
      const started = Date.now();
      await expect(res.text()).rejects.toBeTruthy(); // DOMException TimeoutError/AbortError
      expect(Date.now() - started).toBeLessThan(2500);
    });

    it('a response without a body (204) is returned as it is', async () => {
      handler = (_r, res) => {
        res.writeHead(204);
        res.end();
      };
      expect((await bounded(1024)(base)).status).toBe(204);
    });

    it('an oversized upstream makes a Yahoo call fail as a typed provider ERROR (the breaker counts it)', async () => {
      handler = (_r, res, p) => streamJson(res, p, 100 * MB);
      const yf = createYahooClient(undefined, ((input: unknown, init?: RequestInit) =>
        fetch(base, init)) as typeof fetch);
      // the client's own fetch is the bounded one: drive it the way the library does
      const error = await yf.quote('BBCA.JK').then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(classifyYahooError(error).code).toBe('ERROR');
      await delay(150);
      expect(probe.sent).toBeLessThan(40 * MB);
    }, 30_000);
  });
});
