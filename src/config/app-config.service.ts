import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './env.schema';

/** Typed accessor over the validated environment. */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true }) as Env[K];
  }

  /** Telegram user IDs allowed to use the bot (empty = nobody; fail closed). */
  get allowedTelegramIds(): ReadonlySet<number> {
    return new Set(this.get('TELEGRAM_ALLOWED_USER_IDS'));
  }

  /** True only when TELEGRAM_ACCESS_MODE=public was chosen explicitly. */
  get publicAccess(): boolean {
    return this.get('TELEGRAM_ACCESS_MODE') === 'public';
  }

  get holidays(): string[] {
    return (this.get('MARKET_HOLIDAYS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  }

  get extraScreenerSymbols(): string[] {
    return (this.get('SCREENER_EXTRA_SYMBOLS') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{4}$/.test(s));
  }
}
