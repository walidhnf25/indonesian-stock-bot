import { validateEnv } from './env.schema';

/** Configuration rules added by the 2026-10-07 audit remediation. */
describe('remediation settings', () => {
  const ok = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };
  const run = (env: Record<string, unknown>) => validateEnv({ ...ok, ...env });
  const issues = (env: Record<string, unknown>): string => {
    try {
      run(env);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };

  describe('market-data budget', () => {
    it('defaults: a 2 000/h system reserve inside a 10 000/h ceiling, 300/h per user', () => {
      const env = run({});
      expect(env.MARKET_DATA_GLOBAL_PER_HOUR).toBe(10_000);
      expect(env.MARKET_DATA_SYSTEM_RESERVE_PER_HOUR).toBe(2_000);
      expect(env.MARKET_DATA_USER_UNCACHED_PER_HOUR).toBe(300);
      expect(env.MARKET_DATA_QUEUE_SYSTEM).toBe(100);
      expect(env.MARKET_DATA_GLOBAL_PER_HOUR - env.MARKET_DATA_SYSTEM_RESERVE_PER_HOUR).toBe(8_000);
    });

    it('refuses a reserve that would leave users no budget at all', () => {
      expect(
        issues({
          MARKET_DATA_GLOBAL_PER_HOUR: '1000',
          MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: '1000',
        }),
      ).toMatch(
        /MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: must be smaller than MARKET_DATA_GLOBAL_PER_HOUR/,
      );
      expect(
        issues({
          MARKET_DATA_GLOBAL_PER_HOUR: '1000',
          MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: '5000',
        }),
      ).not.toBe('');
    });

    it('accepts a reserve of 0 (no reserve: one shared pool) and any reserve below the ceiling', () => {
      expect(issues({ MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: '0' })).toBe('');
      expect(
        issues({
          MARKET_DATA_GLOBAL_PER_HOUR: '5000',
          MARKET_DATA_SYSTEM_RESERVE_PER_HOUR: '4999',
        }),
      ).toBe('');
    });

    it.each([
      ['MARKET_DATA_USER_UNCACHED_PER_HOUR', '0'],
      ['MARKET_DATA_USER_UNCACHED_PER_HOUR', '-5'],
      ['MARKET_DATA_USER_UNCACHED_PER_HOUR', 'many'],
      ['MARKET_DATA_SYSTEM_RESERVE_PER_HOUR', '-1'],
      ['MARKET_DATA_QUEUE_SYSTEM', '0'],
    ])('rejects %s=%s', (key, value) => {
      expect(issues({ [key]: value })).toContain(key);
    });
  });

  describe('response ceilings', () => {
    it('have sane defaults', () => {
      const env = run({});
      expect(env.AI_MAX_RESPONSE_BYTES).toBe(1_048_576);
      expect(env.EMBEDDING_MAX_RESPONSE_BYTES).toBe(8_388_608);
      expect(env.MARKET_DATA_MAX_RESPONSE_BYTES).toBe(4_194_304);
    });

    it.each([
      'AI_MAX_RESPONSE_BYTES',
      'EMBEDDING_MAX_RESPONSE_BYTES',
      'MARKET_DATA_MAX_RESPONSE_BYTES',
    ])(
      'bounds %s: not below 4 KiB (would break every answer) and not above 64 MiB (no limit at all)',
      (key) => {
        expect(issues({ [key]: '100' })).toContain(key);
        expect(issues({ [key]: '999999999999' })).toContain(key);
        expect(issues({ [key]: '65536' })).toBe('');
      },
    );
  });

  describe('Redis exposure', () => {
    it('loopback Redis without a password is fine (local development)', () => {
      expect(issues({ REDIS_URL: 'redis://127.0.0.1:6380/0' })).toBe('');
      expect(issues({ REDIS_URL: 'redis://localhost:6380/0' })).toBe('');
      expect(issues({ REDIS_URL: 'redis://[::1]:6380/0' })).toBe('');
    });

    it('a Redis on another host needs a password, and the message never echoes the URL', () => {
      const msg = issues({ REDIS_URL: 'redis://cache.internal.example:6379/0' });
      expect(msg).toMatch(/REDIS_URL: points to a non-loopback host without a password/);
      expect(msg).not.toContain('cache.internal.example');
      expect(issues({ REDIS_URL: 'redis://10.0.0.5:6379' })).not.toBe('');
      expect(issues({ REDIS_URL: 'redis://redis:6379' })).not.toBe('');
    });

    it('a password makes a remote Redis acceptable (without leaking it)', () => {
      expect(issues({ REDIS_URL: 'redis://:s3cret-pw@cache.internal.example:6379/0' })).toBe('');
      expect(issues({ REDIS_URL: 'rediss://default:s3cret-pw@cache.example:6380' })).toBe('');
    });

    it('REDIS_ALLOW_UNAUTHENTICATED=true is the explicit opt-out for a private, trusted network', () => {
      expect(issues({ REDIS_URL: 'redis://redis:6379', REDIS_ALLOW_UNAUTHENTICATED: 'true' })).toBe(
        '',
      );
      expect(
        issues({ REDIS_URL: 'redis://redis:6379', REDIS_ALLOW_UNAUTHENTICATED: 'maybe' }),
      ).toContain('REDIS_ALLOW_UNAUTHENTICATED');
    });

    it('no REDIS_URL means no Redis rule applies', () => {
      expect(issues({})).toBe('');
    });
  });
});
