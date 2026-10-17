import { AppConfig } from '../config/app-config.service';
import { parseAllowedUserIds, validateEnv } from '../config/env.schema';
import { AccessService, UNAUTHORIZED_MESSAGE } from './access.service';

const cfg = (ids: number[]) => ({ allowedTelegramIds: new Set(ids) }) as unknown as AppConfig;
const baseEnv = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('TELEGRAM_ALLOWED_USER_IDS parsing', () => {
  it('accepts one or many IDs separated by commas, semicolons or spaces, and de-duplicates', () => {
    expect(parseAllowedUserIds('123456789').ids).toEqual([123456789]);
    expect(parseAllowedUserIds('123456789,987654321').ids).toEqual([123456789, 987654321]);
    expect(parseAllowedUserIds(' 1 , 2 ;3  4,2 ').ids).toEqual([1, 2, 3, 4]);
  });

  it('accepts the whole range of Telegram user IDs (up to 52 bits = 16 digits)', () => {
    expect(parseAllowedUserIds('4503599627370495').ids).toEqual([4503599627370495]);
    expect(parseAllowedUserIds('7654321098').ids).toEqual([7654321098]);
  });

  it('treats missing or empty configuration as an EMPTY list (fail closed), not as "everyone"', () => {
    expect(parseAllowedUserIds(undefined)).toEqual({ ids: [], invalid: [] });
    expect(parseAllowedUserIds('')).toEqual({ ids: [], invalid: [] });
    expect(parseAllowedUserIds('   ')).toEqual({ ids: [], invalid: [] });
    expect(validateEnv(baseEnv).TELEGRAM_ALLOWED_USER_IDS).toEqual([]);
    expect(
      validateEnv({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: '' }).TELEGRAM_ALLOWED_USER_IDS,
    ).toEqual([]);
  });

  it.each([
    ['letters', 'abc'],
    ['one bad entry among good ones', '123456789,abc'],
    ['negative id (group chat ids are not users)', '-100123456'],
    ['zero', '0'],
    ['decimal', '1.5'],
    ['wildcard', '*'],
    ['mention', '@someone'],
    ['too long to be a safe integer', '12345678901234567890'],
    ['16 digits but above the safe-integer range', '9999999999999999'],
    ['mixed token', '123abc'],
  ])('rejects malformed configuration: %s', (_label, raw) => {
    expect(parseAllowedUserIds(raw).invalid.length).toBeGreaterThan(0);
    expect(() => validateEnv({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: raw })).toThrow(
      /TELEGRAM_ALLOWED_USER_IDS/,
    );
  });

  it('never echoes the configured value in the error (only the position)', () => {
    try {
      validateEnv({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: '111,secretish-typo' });
      fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('entry #2');
      expect(msg).not.toContain('secretish-typo');
    }
  });

  it('parses through validateEnv into numbers', () => {
    expect(
      validateEnv({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: '123456789, 987654321' })
        .TELEGRAM_ALLOWED_USER_IDS,
    ).toEqual([123456789, 987654321]);
  });
});

describe('AccessService', () => {
  it('allows only listed Telegram IDs (authorized vs unauthorized)', () => {
    const access = new AccessService(cfg([111, 222]));
    expect(access.isAllowed(111)).toBe(true);
    expect(access.isAllowed(222)).toBe(true);
    expect(access.isAllowed(333)).toBe(false);
    expect(access.isConfigured).toBe(true);
  });

  it('fails closed when nothing is configured: nobody is allowed', () => {
    const access = new AccessService(cfg([]));
    expect(access.isConfigured).toBe(false);
    for (const id of [1, 111, 123456789, 0]) expect(access.isAllowed(id)).toBe(false);
  });

  it.each([
    ['numeric string', '111'],
    ['float', 111.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['undefined', undefined],
    ['null', null],
    ['bigint', BigInt(111)],
    ['object', { id: 111 }],
    ['unsafe integer', 2 ** 60],
    ['array', [111]],
  ])('type-confusion does not bypass the check: %s', (_label, value) => {
    const access = new AccessService(cfg([111]));
    expect(access.isAllowed(value)).toBe(false);
  });

  describe('TELEGRAM_ACCESS_MODE=public (explicit opt-in)', () => {
    const pub = (ids: number[] = []) =>
      new AccessService({
        allowedTelegramIds: new Set(ids),
        publicAccess: true,
      } as unknown as AppConfig);

    it('admits any well-formed Telegram user ID, listed or not', () => {
      const access = new AccessService({
        allowedTelegramIds: new Set<number>(),
        publicAccess: true,
      } as unknown as AppConfig);
      expect(access.isPublic).toBe(true);
      expect(access.isConfigured).toBe(true);
      for (const id of [1, 111, 123456789, 4503599627370495])
        expect(access.isAllowed(id)).toBe(true);
    });

    it('the allowlist is ignored in public mode (listed and unlisted users are treated alike)', () => {
      const access = pub([111]);
      expect(access.isAllowed(111)).toBe(true);
      expect(access.isAllowed(333)).toBe(true);
    });

    it.each([
      ['zero', 0],
      ['negative (a group/channel id, not a user)', -100123],
      ['numeric string', '111'],
      ['float', 1.5],
      ['NaN', NaN],
      ['undefined', undefined],
      ['null', null],
      ['unsafe integer', 2 ** 60],
    ])('public mode still rejects malformed sender ids: %s', (_label, value) => {
      expect(pub().isAllowed(value)).toBe(false);
    });

    it('the default mode is NOT public (no accidental opening)', () => {
      expect(new AccessService(cfg([])).isPublic).toBe(false);
      expect(new AccessService(cfg([111])).isPublic).toBe(false);
      expect(validateEnv(baseEnv).TELEGRAM_ACCESS_MODE).toBe('allowlist');
      expect(validateEnv({ ...baseEnv, TELEGRAM_ACCESS_MODE: '' }).TELEGRAM_ACCESS_MODE).toBe(
        'allowlist',
      );
    });

    it('an empty allowlist alone never means public', () => {
      const access = new AccessService(cfg([]));
      expect(access.isAllowed(111)).toBe(false);
    });

    it('parses the mode case-insensitively and rejects unknown values (startup error, not silent fallback)', () => {
      expect(validateEnv({ ...baseEnv, TELEGRAM_ACCESS_MODE: 'PUBLIC' }).TELEGRAM_ACCESS_MODE).toBe(
        'public',
      );
      expect(
        validateEnv({ ...baseEnv, TELEGRAM_ACCESS_MODE: ' public ' }).TELEGRAM_ACCESS_MODE,
      ).toBe('public');
      for (const bad of ['open', 'all', 'true', '*', 'publik']) {
        expect(() => validateEnv({ ...baseEnv, TELEGRAM_ACCESS_MODE: bad })).toThrow(
          /TELEGRAM_ACCESS_MODE/,
        );
      }
    });
  });

  it('the rejection text does not reveal the allowlist or its size', () => {
    expect(UNAUTHORIZED_MESSAGE).toBe(
      'Maaf, bot ini saat ini hanya dapat digunakan oleh pengguna yang diizinkan.',
    );
    expect(UNAUTHORIZED_MESSAGE).not.toMatch(/\d/);
  });

  it('throttles logging (1/min) and replies (1/5 min) per rejected user, independently per user', () => {
    const access = new AccessService(cfg([111]));
    const t0 = 1_000_000;
    expect(access.noteRejection(999, t0)).toEqual({ shouldLog: true, shouldReply: true });
    expect(access.noteRejection(999, t0 + 5_000)).toEqual({ shouldLog: false, shouldReply: false });
    expect(access.noteRejection(999, t0 + 61_000)).toEqual({ shouldLog: true, shouldReply: false });
    expect(access.noteRejection(999, t0 + 5 * 60_000 + 1)).toEqual({
      shouldLog: true,
      shouldReply: true,
    });
    // another stranger is tracked separately
    expect(access.noteRejection(888, t0 + 5_000)).toEqual({ shouldLog: true, shouldReply: true });
  });
});
