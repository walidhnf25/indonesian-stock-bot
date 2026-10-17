import express, { json } from 'express';
import request from 'supertest';
import { isLoopbackHost, validateEnv } from '../config/env.schema';
import { localOnly, MAX_BODY_BYTES } from './http-setup';
import { MAX_SCRUB_INPUT, safeErrorMessage, scrub } from './utils/scrub';

/** Regressions: REST exposure, secret scrubbing and environment validation. */

describe('scrub() covers the shapes the review found leaking', () => {
  const TOKEN = `000000001:${'FAKE_NOT_A_REAL_TOKEN_'.padEnd(35, '0')}`;

  it.each([
    ['URL-encoded Telegram token', `x ${TOKEN.replace(':', '%3A')} y`, /FAKE_NOT_A_REAL/],
    ['token in a bot API URL', `https://api.telegram.org/bot${TOKEN}/getMe`, /FAKE_NOT_A_REAL/],
    ['postgres URL password', 'postgresql://postgres:supersecret@localhost:5432/db', /supersecret/],
    ['basic auth in an http URL', 'http://admin:s3cret@ollama.internal:11434/api', /s3cret/],
    ['password in a redis URL with empty user', 'redis://:pw123@cache:6379', /pw123/],
    ['JSON "password"', '{"password":"hunter2","user":"x"}', /hunter2/],
    ['JSON "api_key" with spaces', '{"api_key": "abc def ghi", "n": 1}', /abc def ghi/],
    ['single-quoted JSON-ish token', "{'token': 'x y z'}", /x y z/],
    ['quoted value with spaces', 'password="correct horse battery" next', /correct horse/],
    ['single-quoted value with spaces', "secret='x y z' next", /x y z/],
    [
      'prefixed variable names',
      'OPENAI_API_KEY=sk-short and DB_PASSWORD=hunter2',
      /sk-short|hunter2/,
    ],
    ['Authorization header', 'Authorization: Bearer abcdef123456', /abcdef123456/],
    ['query-string key', 'GET /x?key=abc123&b=1', /abc123/],
  ])('%s', (_label, input, secret) => {
    const out = scrub(input);
    expect(out).not.toMatch(secret);
    expect(out).toMatch(/REDACTED/);
  });

  it('leaves ordinary text alone (no over-redaction)', () => {
    const text =
      'the password policy was reviewed; passport ok; tokenizer ready; GET /stocks/BBCA 200';
    expect(scrub(text)).toBe(text);
    const url = 'https://example.com/path?x=1';
    expect(scrub(url)).toBe(url);
  });

  it('keeps the useful rest of an error message', () => {
    const out = scrub(
      'upstream: password=hunter2 at /srv/runner.go:12 TOKEN=abc123 secret: s3cr3t',
    );
    expect(out).toContain('/srv/runner.go:12');
    expect(out).not.toMatch(/hunter2|abc123|s3cr3t/);
  });

  it('safeErrorMessage scrubs and bounds', () => {
    const e = new Error('connect http://u:pw123@h/db failed ' + 'x'.repeat(1000));
    const m = safeErrorMessage(e);
    expect(m).not.toContain('pw123');
    expect(m.length).toBeLessThanOrEqual(500);
  });
});

describe('environment validation', () => {
  const ok = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
  const issues = (env: Record<string, unknown>): string => {
    try {
      validateEnv({ ...ok, ...env });
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  describe('switches accept true/false, 1/0, yes/no, on/off and reject anything else', () => {
    it.each([
      ['TELEGRAM_ENABLED', '0', false],
      ['TELEGRAM_ENABLED', 'no', false],
      ['TELEGRAM_ENABLED', 'OFF', false],
      ['TELEGRAM_ENABLED', 'False', false],
      ['TELEGRAM_ENABLED', '1', true],
      ['TELEGRAM_ENABLED', 'yes', true],
      ['TELEGRAM_ENABLED', ' ON ', true],
      ['ALERT_CHECK_WHEN_CLOSED', '1', true],
      ['ALERT_CHECK_WHEN_CLOSED', 'TRUE', true],
      ['ALERT_CHECK_WHEN_CLOSED', '0', false],
      ['REST_ALLOW_REMOTE', 'true', true],
    ])('%s=%s -> %s', (key, value, expected) => {
      expect(
        validateEnv({
          ...ok,
          [key]: value,
          ...(key === 'REST_ALLOW_REMOTE' ? { HOST: '0.0.0.0' } : {}),
        })[key as 'TELEGRAM_ENABLED'],
      ).toBe(expected);
    });

    it('defaults when empty or unset', () => {
      const env = validateEnv({ ...ok, TELEGRAM_ENABLED: '', ALERT_CHECK_WHEN_CLOSED: '  ' });
      expect(env.TELEGRAM_ENABLED).toBe(true);
      expect(env.ALERT_CHECK_WHEN_CLOSED).toBe(false);
      expect(env.REST_ALLOW_REMOTE).toBe(false);
    });

    it.each(['maybe', 'enabled', 'tru', '2', 'nope'])(
      '"%s" is an error, not a silent default',
      (v) => {
        expect(issues({ TELEGRAM_ENABLED: v })).toMatch(/TELEGRAM_ENABLED: must be true\/false/);
        expect(issues({ ALERT_CHECK_WHEN_CLOSED: v })).toMatch(/ALERT_CHECK_WHEN_CLOSED/);
      },
    );
  });

  describe("numbers have upper bounds (a huge interval overflows Node's 32-bit timer)", () => {
    it.each([
      ['ALERT_CHECK_INTERVAL_SECONDS', '3601'],
      ['ALERT_CHECK_INTERVAL_SECONDS', '360000000'],
      ['RETENTION_INTERVAL_HOURS', '169'],
      ['RETENTION_INTERVAL_HOURS', '600'],
      ['PORT', '65536'],
      ['PORT', '99999'],
      ['AI_TIMEOUT_MS', '600001'],
      ['MAX_INPUT_LENGTH', '20001'],
      ['MAX_SYMBOLS_PER_REQUEST', '21'],
      ['AI_MAX_CONCURRENT_REQUESTS', '17'],
      ['FETCH_LOG_RETENTION_DAYS', '3651'],
      ['USER_RATE_LIMIT_PER_MINUTE', '10001'],
    ])('%s=%s is refused', (key, value) => {
      expect(issues({ [key]: value })).toContain(key);
    });

    it.each([
      ['ALERT_CHECK_INTERVAL_SECONDS', '3600'],
      ['RETENTION_INTERVAL_HOURS', '168'],
      ['PORT', '65535'],
      ['MAX_SYMBOLS_PER_REQUEST', '20'],
    ])('%s=%s (the boundary itself) is accepted', (key, value) => {
      expect(issues({ [key]: value })).toBe('');
    });

    it('error messages never echo values', () => {
      expect(issues({ PORT: '99999' })).not.toContain('99999');
    });
  });

  it('TZ must be a real IANA zone', () => {
    expect(issues({ TZ: 'Bogus/Zone' })).toContain('TZ');
    expect(issues({ TZ: 'Asia/Jakarta' })).toBe('');
    expect(validateEnv({ ...ok, TZ: '' }).TZ).toBe('Asia/Jakarta');
  });

  it('a cloud AI provider needs its key at startup, not at the first request', () => {
    expect(issues({ AI_PROVIDER: 'gemini' })).toContain('GEMINI_API_KEY: is required');
    expect(issues({ AI_PROVIDER: 'openai' })).toContain('OPENAI_API_KEY: is required');
    expect(issues({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).toBe('');
    expect(issues({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })).toBe('');
    expect(issues({ AI_PROVIDER: 'ollama' })).toBe('');
    expect(issues({ AI_PROVIDER: 'gemini' })).not.toMatch(/AIza/);
  });

  describe('the unauthenticated REST API stays on loopback unless explicitly opened', () => {
    it.each(['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5', 'LOCALHOST'])(
      'HOST=%s is fine',
      (host) => {
        expect(issues({ HOST: host })).toBe('');
        expect(isLoopbackHost(host)).toBe(true);
      },
    );

    it.each([
      '0.0.0.0',
      '192.168.1.10',
      '10.0.0.5',
      'example.com',
      '::',
      '127.0.0.1.evil.com',
      '1270.0.0.1',
    ])('HOST=%s is refused at startup', (host) => {
      expect(isLoopbackHost(host)).toBe(false);
      expect(issues({ HOST: host })).toMatch(/HOST: ".*" is not a loopback address/);
    });

    it('REST_ALLOW_REMOTE=true is the explicit opt-in', () => {
      expect(issues({ HOST: '0.0.0.0', REST_ALLOW_REMOTE: 'true' })).toBe('');
      expect(issues({ HOST: '0.0.0.0', REST_ALLOW_REMOTE: 'false' })).toContain('HOST');
    });

    it('an empty HOST means the safe default, not "all interfaces"', () => {
      expect(validateEnv({ ...ok, HOST: '' }).HOST).toBe('127.0.0.1');
      expect(validateEnv({ ...ok, HOST: '   ' }).HOST).toBe('127.0.0.1');
    });
  });
});

describe('localOnly middleware (Host and Origin)', () => {
  const app = express();
  app.use(json({ limit: MAX_BODY_BYTES }));
  app.use(localOnly);
  app.get('/x', (_req, res) => res.json({ ok: true }));
  app.post('/x', (_req, res) => res.json({ ok: true }));

  it.each([
    'localhost',
    'localhost:3000',
    '127.0.0.1:3000',
    '127.0.0.1',
    '[::1]:3000',
    'LOCALHOST:80',
  ])('Host: %s is served', async (host) => {
    await request(app).get('/x').set('Host', host).expect(200);
  });

  it.each([
    'example.com',
    'evil.example:3000',
    'localhost.evil.com',
    '127.0.0.1.evil.com',
    '192.168.1.5:3000',
    '0.0.0.0',
  ])('Host: %s is refused (DNS rebinding / remote access)', async (host) => {
    const res = await request(app).get('/x').set('Host', host).expect(403);
    expect(res.body.message).toMatch(/Host/);
  });

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'https://localhost',
    'http://[::1]:8080',
  ])('Origin: %s (a local page) is served', async (origin) => {
    await request(app).post('/x').set('Origin', origin).expect(200);
  });

  it.each([
    'http://evil.example',
    'https://example.com',
    'null',
    'not a url',
    'http://localhost.evil.com',
    'file://',
  ])('Origin: %s is refused (a web page firing requests at the local machine)', async (origin) => {
    const res = await request(app).post('/x').set('Origin', origin).expect(403);
    expect(res.body.message).toMatch(/Origin/);
  });

  it('requests without an Origin (curl, scripts, monitors) are unaffected', async () => {
    await request(app).get('/x').expect(200);
    await request(app).post('/x').expect(200);
  });

  it('a body above the limit is rejected by the parser with a 4xx status, not a crash', async () => {
    const res = await request(app)
      .post('/x')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(50_000) }));
    expect(res.status).toBe(413);
  });
});

describe('scrub() is linear and covers more name forms', () => {
  it.each([
    ['passwd=hunter2', /hunter2/],
    ['secret_value=abc123', /abc123/],
    ['apikey=abc123', /abc123/],
    ['curl x key=abc123 y', /abc123/],
    ['password%3Dhunter2', /hunter2/],
    ['access_token_id: 99887766', /99887766/],
    ['db_password_hash=deadbeef', /deadbeef/],
  ])('redacts %s', (input, secret) => {
    const out = scrub(input);
    expect(out).not.toMatch(secret);
    expect(out).toMatch(/REDACTED/);
  });

  it.each(['tokenizer ready', 'passport ok', 'key: value', 'the password policy', 'monkey=banana'])(
    'leaves %s alone',
    (text) => {
      expect(scrub(text)).toBe(text);
    },
  );

  it.each([
    ['dots', 'a.'.repeat(60_000)],
    ['plus', 'a+'.repeat(60_000)],
    ['dashes', 'x-'.repeat(60_000)],
    ['one long word', 'a'.repeat(100_000)],
    ['repeated keyword', 'pass'.repeat(25_000)],
    ['repeated scheme', 'http://'.repeat(15_000)],
    ['repeated userinfo', 'http://a:'.repeat(10_000)],
    ['many open quotes', 'password="'.repeat(10_000)],
  ])('100 kB of %s is handled in well under a second', (_label, input) => {
    const started = Date.now();
    scrub(input);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('only looks at the first MAX_SCRUB_INPUT characters', () => {
    const out = scrub('x'.repeat(MAX_SCRUB_INPUT + 5000));
    expect(out.length).toBeLessThanOrEqual(MAX_SCRUB_INPUT + 1);
  });

  it('a secret at the very start of a huge message is still removed', () => {
    const out = scrub('password=hunter2 ' + 'y'.repeat(50_000));
    expect(out).not.toContain('hunter2');
  });
});

describe('scrub() at the start of a string', () => {
  it.each(['key=abc123 rest', 'token=abc123', 'api_key=abc123&x=1'])('redacts %s', (input) => {
    expect(scrub(input)).not.toContain('abc123');
  });
  it('still leaves "monkey=banana" alone', () => {
    expect(scrub('monkey=banana')).toBe('monkey=banana');
  });
});
