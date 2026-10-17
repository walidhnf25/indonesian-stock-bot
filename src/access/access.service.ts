import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';

export const UNAUTHORIZED_MESSAGE =
  'Maaf, bot ini saat ini hanya dapat digunakan oleh pengguna yang diizinkan.';

const REPLY_COOLDOWN_MS = 5 * 60_000;
const LOG_COOLDOWN_MS = 60_000;
const MAX_TRACKED = 5000;

/**
 * Authorization boundary for Telegram users.
 *
 * Default policy: FAIL CLOSED. Only IDs listed in TELEGRAM_ALLOWED_USER_IDS may use the bot. An empty
 * list means nobody is allowed (the bot still starts, so the owner can read the log, find their ID in
 * the "unauthorized user" warning and configure it).
 *
 * The only way to open the bot to everybody is the explicit, separate switch
 * TELEGRAM_ACCESS_MODE=public. A missing/empty list can never turn into "public" by accident.
 * Public mode only ever admits a well-formed Telegram user ID; per-user rate limits, AI quotas and the
 * bounded AI queue keep applying to everyone.
 *
 * This service holds no secrets and never reveals the allowlist: callers only get a boolean.
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private readonly allowed: ReadonlySet<number>;
  private readonly publicMode: boolean;
  private readonly lastReply = new Map<number, number>();
  private readonly lastLog = new Map<number, number>();

  constructor(config: AppConfig) {
    this.allowed = new Set(config.allowedTelegramIds);
    this.publicMode = config.publicAccess === true;
    if (this.publicMode) {
      this.logger.warn(
        'TELEGRAM_ACCESS_MODE=public: EVERY Telegram user can use this bot and consume the local CPU/AI model ' +
          '(per-user limits and the bounded AI queue still apply).' +
          (this.allowed.size > 0
            ? ` TELEGRAM_ALLOWED_USER_IDS (${this.allowed.size} entries) is ignored in this mode.`
            : ''),
      );
    } else if (this.allowed.size === 0) {
      this.logger.warn(
        'TELEGRAM_ALLOWED_USER_IDS is empty: every Telegram user will be rejected (fail closed). ' +
          'Send the bot a message, read your ID in the "unauthorized user" log line, add it to .env and restart.',
      );
    } else {
      this.logger.log(`Telegram allowlist active (${this.allowed.size} user(s)).`);
    }
  }

  get isConfigured(): boolean {
    return this.publicMode || this.allowed.size > 0;
  }

  get isPublic(): boolean {
    return this.publicMode;
  }

  isAllowed(telegramId: unknown): boolean {
    if (typeof telegramId !== 'number' || !Number.isSafeInteger(telegramId)) return false;
    if (this.publicMode) return telegramId > 0; // a real Telegram user ID, nothing else
    return this.allowed.has(telegramId);
  }

  /**
   * Records a rejection and says whether to log it / answer the sender. Both are throttled per user
   * so a stranger cannot flood the log or make the bot spam the Telegram API.
   */
  noteRejection(
    telegramId: number,
    now = Date.now(),
  ): { shouldLog: boolean; shouldReply: boolean } {
    const shouldLog = this.cooldown(this.lastLog, telegramId, LOG_COOLDOWN_MS, now);
    const shouldReply = this.cooldown(this.lastReply, telegramId, REPLY_COOLDOWN_MS, now);
    if (shouldLog) {
      this.logger.warn(
        JSON.stringify({
          evt: 'unauthorized_user',
          telegramId,
          allowlistConfigured: this.isConfigured,
        }),
      );
    }
    return { shouldLog, shouldReply };
  }

  private cooldown(map: Map<number, number>, id: number, ms: number, now: number): boolean {
    const prev = map.get(id);
    if (prev !== undefined && now - prev < ms) return false;
    if (map.size >= MAX_TRACKED) map.delete(map.keys().next().value as number);
    map.set(id, now);
    return true;
  }
}
