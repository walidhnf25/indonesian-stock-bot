import { User } from '@prisma/client';
import { ParsedIntent } from '../intent/intent.types';

export interface ChatRequest {
  telegramId: number;
  chatId: number;
  /** Telegram chat type ("private" | "group" | "supergroup"); defaults to "private" (CLI, tests). */
  chatType?: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  text: string;
  /** Telegram message id; makes a retried update idempotent for bookkeeping (portfolio). */
  messageId?: number;
  /**
   * Skips the Telegram allowlist. ONLY for trusted in-process callers (the local `npm run chat`
   * tool). Never set from transport input: the Telegram layer must not pass this.
   */
  trusted?: boolean;
  /** Optional: lets slow handlers (AI) send "working on it" / finished-part messages immediately. */
  progress?: (htmlText: string) => Promise<void>;
}

export interface ChatReply {
  /** HTML messages, each already within Telegram's size limit. */
  messages: string[];
  intent: ParsedIntent['intent'];
  /** True when the sender was rejected by the allowlist (nothing else was processed). */
  unauthorized?: boolean;
}

export interface HandlerContext {
  user: User;
  /** The chat this message came from. Alerts are bound to it; it is never read from user state. */
  chat: { id: number; type: string };
  intent: ParsedIntent;
  messageId?: number;
  progress?: (htmlText: string) => Promise<void>;
  /** Logging fields handlers may add (provider, ai timings, freshness...). */
  log: Record<string, unknown>;
}
