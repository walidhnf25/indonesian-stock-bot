import { TtlCache } from './cache/ttl-cache';
import { mapLimit } from './utils/async';
import {
  escapeHtml,
  round,
  formatCompactId,
  formatPercent,
  formatRatio,
  formatRupiah,
  formatSigned,
  formatWib,
  jakartaParts,
} from './utils/format';
import { SlidingWindowLimiter, Throttle } from './utils/rate-limiter';
import { withRetry, withTimeout } from './utils/retry';
import { safeErrorMessage, scrub } from './utils/scrub';
import { Semaphore } from './utils/semaphore';
import { cleanCompanyName } from './utils/text';
import { validateEnv } from '../config/env.schema';

describe('formatting (Indonesian locale)', () => {
  it('formats rupiah with dot thousands separators', () => {
    expect(formatRupiah(8125)).toBe('Rp8.125');
    expect(formatRupiah(1250000)).toBe('Rp1.250.000');
    expect(formatRupiah(null)).toBe('-');
    expect(formatRupiah(NaN)).toBe('-');
  });
  it('formats signed percent with decimal comma', () => {
    expect(formatPercent(1.25)).toBe('+1,25%');
    expect(formatPercent(-0.46)).toBe('-0,46%');
    expect(formatPercent(0)).toBe('0,00%');
    expect(formatPercent(null)).toBe('-');
  });
  it('formats signed numbers, ratios and compact values', () => {
    expect(formatSigned(100)).toBe('+100');
    expect(formatSigned(-75)).toBe('-75');
    expect(formatRatio(1.42)).toBe('1,42x');
    expect(formatCompactId(118_044_900)).toBe('118,04 jt');
    expect(formatCompactId(7.37e14)).toBe('737,00 T');
  });
  it('formats timestamps in WIB', () => {
    expect(formatWib('2026-10-01T09:14:25.000Z')).toBe('1 Oktober 2026, 16:14 WIB');
    expect(formatWib('2026-10-01T08:59:00.000Z')).toBe('1 Oktober 2026, 15:59 WIB');
    expect(formatWib('invalid')).toBe('-');
  });
  it('rounds half away from zero, in step with the printed text', () => {
    expect(round(9.125)).toBe(9.13);
    expect(round(-9.125)).toBe(-9.13); // Math.round alone gave -9.12 while the fact printed 9,13%
    expect(round(-0.001)).toBe(0);
    expect(Object.is(round(-0.001), -0)).toBe(false);
    expect(round(1.005, 2)).toBe(1); // binary 1.00499..., same as toFixed
    expect(round(2.5, 0)).toBe(3);
    expect(round(-2.5, 0)).toBe(-3);
    expect(round(Number.NaN)).toBeNaN();
    expect(formatPercent(-9.125)).toBe('-9,13%');
  });
  it('escapes HTML', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
  });
  it('computes Jakarta wall-clock parts', () => {
    expect(jakartaParts(new Date('2026-10-04T18:00:00Z'))).toMatchObject({
      isoDate: '2026-10-05',
      hour: 1,
      weekday: 1,
    });
  });
});

describe('TtlCache', () => {
  it('expires entries and de-duplicates concurrent loads', async () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 10, () => now);
    let loads = 0;
    const loader = async () => {
      loads++;
      await Promise.resolve();
      return 42;
    };
    const [a, b] = await Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
    expect([a, b, loads]).toEqual([42, 42, 1]);
    expect(await cache.getOrLoad('k', loader)).toBe(42);
    expect(loads).toBe(1); // served from cache
    now = 1001;
    await cache.getOrLoad('k', loader);
    expect(loads).toBe(2);
  });
  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(1000);
    await expect(cache.getOrLoad('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await cache.getOrLoad('k', () => Promise.resolve(1))).toBe(1);
  });
  it('evicts the oldest entry beyond capacity', () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')?.value).toBe(3);
  });
});

describe('SlidingWindowLimiter', () => {
  it('blocks after the limit and recovers after the window', () => {
    let now = 0;
    const l = new SlidingWindowLimiter(2, 1000, () => now);
    expect(l.tryConsume('u').allowed).toBe(true);
    expect(l.tryConsume('u').allowed).toBe(true);
    const blocked = l.tryConsume('u');
    expect(blocked).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(l.tryConsume('other').allowed).toBe(true); // keyed per user
    now = 1001;
    expect(l.tryConsume('u').allowed).toBe(true);
  });
});

describe('Throttle', () => {
  it('limits concurrency', async () => {
    const t = new Throttle(2, 0);
    let active = 0;
    let max = 0;
    const task = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => t.run(task)));
    expect(max).toBe(2);
  });
  it('enforces a minimum interval between starts', async () => {
    const t = new Throttle(5, 40);
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 3 }, () =>
        t.run(async () => {
          starts.push(Date.now());
        }),
      ),
    );
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(70);
  });
});

describe('withRetry / withTimeout / mapLimit / Semaphore', () => {
  it('retries with exponential backoff then succeeds', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw new Error('boom');
        return 'ok';
      },
      {
        retries: 3,
        baseDelayMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(out).toBe('ok');
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
  });
  it('gives up after the retry budget and honours shouldRetry', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error('x');
        },
        { retries: 2, baseDelayMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toThrow('x');
    expect(n).toBe(3);
    n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error('fatal');
        },
        { retries: 5, baseDelayMs: 1, shouldRetry: () => false, sleep: async () => undefined },
      ),
    ).rejects.toThrow('fatal');
    expect(n).toBe(1);
  });
  it('times out slow operations', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 10, 'slow')).rejects.toThrow(
      /slow timed out/,
    );
  });
  it('mapLimit preserves order with bounded parallelism', async () => {
    let active = 0;
    let max = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(max).toBeLessThanOrEqual(2);
  });
  it('Semaphore releases waiters in order', async () => {
    const s = new Semaphore(1);
    const order: number[] = [];
    const r1 = await s.acquire();
    const p2 = s.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = s.acquire().then((r) => {
      order.push(3);
      r();
    });
    order.push(1);
    r1();
    await Promise.all([p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('secret scrubbing', () => {
  it('redacts Telegram tokens, DB passwords and API keys', () => {
    const token = `000000001:${'FAKE_NOT_A_REAL_TOKEN_'.padEnd(35, '0')}`;
    expect(scrub(`failed https://api.telegram.org/bot${token}/getMe`)).not.toContain(
      'FAKE_NOT_A_REAL',
    );
    expect(scrub('postgresql://postgres:supersecret@localhost:5432/db')).toBe(
      'postgresql://postgres:[REDACTED]@localhost:5432/db',
    );
    expect(scrub('GET /x?key=abc123&b=1')).toBe('GET /x?key=[REDACTED]&b=1');
    expect(scrub(`Bearer ${['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-')}`)).not.toContain(
      'abcdefghijklmnop',
    );
    expect(scrub('AIzaSyA1234567890abcdefghijklmnopqrstu')).toBe('[REDACTED_KEY]');
    // secrets that only appear as key=value inside an upstream error body
    const body =
      'internal error: password=hunter2 at /srv/runner.go:12 TOKEN=abc123 secret: s3cr3t';
    const cleaned = scrub(body);
    expect(cleaned).not.toMatch(/hunter2|abc123|s3cr3t/);
    expect(cleaned).toContain('password=[REDACTED]');
    expect(cleaned).toContain('/srv/runner.go:12'); // the rest of the message stays useful
  });
  it('safeErrorMessage never leaks and is bounded', () => {
    const e = new Error('connect postgresql://u:pw123@h/db failed ' + 'x'.repeat(1000));
    const m = safeErrorMessage(e);
    expect(m).not.toContain('pw123');
    expect(m.length).toBeLessThanOrEqual(500);
  });
});

describe('environment validation', () => {
  const ok = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

  it('applies defaults', () => {
    const env = validateEnv(ok);
    expect(env).toMatchObject({
      AI_PROVIDER: 'ollama',
      PORT: 3000,
      STOCK_DATA_PROVIDER: 'yahoo',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
    });
    expect(env.OLLAMA_BASE_URL).toBe('http://localhost:11434');
  });
  it('treats empty strings as unset (so a blank .env line uses the default)', () => {
    const env = validateEnv({ ...ok, PORT: '', OLLAMA_MODEL: '', TELEGRAM_BOT_TOKEN: '' });
    expect(env.PORT).toBe(3000);
    expect(env.OLLAMA_MODEL).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
  it('requires DATABASE_URL and a PostgreSQL scheme', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ DATABASE_URL: 'file:./dev.db' })).toThrow(/PostgreSQL/);
  });
  it('rejects unsupported providers and bad numbers', () => {
    expect(() => validateEnv({ ...ok, AI_PROVIDER: 'skynet' })).toThrow(/AI_PROVIDER/);
    expect(() => validateEnv({ ...ok, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...ok, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
  it('never echoes secret values in the error message', () => {
    try {
      validateEnv({ DATABASE_URL: 'mysql://root:topsecretpw@h/db' });
      fail('should throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('topsecretpw');
    }
  });
  it('parses booleans', () => {
    expect(validateEnv({ ...ok, ALERT_CHECK_WHEN_CLOSED: 'true' }).ALERT_CHECK_WHEN_CLOSED).toBe(
      true,
    );
    expect(validateEnv(ok).ALERT_CHECK_WHEN_CLOSED).toBe(false);
  });
});

describe('cleanCompanyName (provider text that reaches prompts, the database and Telegram)', () => {
  const ZW = String.fromCharCode(0x200b);
  const RLO = String.fromCharCode(0x202e);

  it('keeps ordinary names', () => {
    expect(cleanCompanyName('Bank Central Asia Tbk')).toBe('Bank Central Asia Tbk');
    expect(cleanCompanyName('PT Astra International Tbk.')).toBe('PT Astra International Tbk.');
    expect(cleanCompanyName('Indah Kiat Pulp & Paper (Persero) Tbk')).toBe(
      'Indah Kiat Pulp & Paper (Persero) Tbk',
    );
  });

  it('removes markup, quotes, braces, control and invisible characters', () => {
    expect(cleanCompanyName('A<b>B</b>C')).toBe('A b B /b C');
    expect(cleanCompanyName('X {"a":"b"} Y')).toBe('X a : b Y');
    expect(cleanCompanyName(`Bank${ZW}Test${RLO}Tbk`)).toBe('Bank Test Tbk');
    expect(cleanCompanyName('Line1\nLine2\tTab\u0000Nul')).toBe('Line1 Line2 Tab Nul');
    expect(cleanCompanyName('a`b' + String.fromCharCode(92) + 'c')).toBe('a b c');
  });

  it('folds compatibility forms and bounds the length', () => {
    expect(cleanCompanyName('ＢＡＮＫ')).toBe('BANK');
    expect(cleanCompanyName('x'.repeat(500))).toHaveLength(80);
  });

  it('returns null for empty or non-text values', () => {
    for (const v of ['', '   ', '<>', null, undefined, 42, {}]) {
      expect(cleanCompanyName(v)).toBeNull();
    }
  });
});
