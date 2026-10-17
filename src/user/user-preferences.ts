import { normalizeTicker } from '../common/utils/ticker';

/**
 * Persistent, user-set preferences. The set is deliberately small: a preference is only added
 * when it has a deterministic, side-effect-free use. Anything not in the allowlist is dropped on read, so
 * a malformed or hand-edited JSON column can never reach a handler.
 */
export interface UserPreferences {
  /** Used for a stock question without a ticker when the chat has no recent context ("berapa RSI?"). */
  defaultSymbol?: string;
  /** 'ringkas' trims the analysis card (never its risks); default 'lengkap'. */
  detail?: 'ringkas' | 'lengkap';
}

export function readPreferences(raw: unknown): UserPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: UserPreferences = {};
  const r = raw as Record<string, unknown>;
  if (typeof r.defaultSymbol === 'string') {
    const symbol = normalizeTicker(r.defaultSymbol);
    if (symbol) out.defaultSymbol = symbol;
  }
  if (r.detail === 'ringkas' || r.detail === 'lengkap') out.detail = r.detail;
  return out;
}
