import { z } from 'zod';
import { normalizeTicker } from '../common/utils/ticker';
import {
  AlertCondition,
  AlertMetric,
  IntentName,
  ParsedIntent,
  TechnicalTopic,
} from './intent.types';

/**
 * Absolute ceiling against abuse/garbage. The user-facing limit (MAX_SYMBOLS_PER_REQUEST) is
 * enforced later by ChatService with an explicit message; tickers are never silently dropped here.
 */
export const HARD_SYMBOL_CAP = 20;

/** Intents that cannot run without at least one ticker. */
export const NEEDS_SYMBOL: ReadonlySet<IntentName> = new Set<IntentName>([
  'STOCK_QUOTE',
  'STOCK_HISTORICAL',
  'STOCK_TECHNICAL',
  'STOCK_ANALYSIS',
  'STOCK_QUESTION',
  'STOCK_ADVICE',
  'FOREIGN_FLOW',
  'BROKER_SUMMARY',
  'FUNDAMENTALS',
  'STOCK_NEWS',
  'ALERT_CREATE',
  'WATCHLIST_ADD',
  'WATCHLIST_REMOVE',
]);

/** Intents that act on exactly one ticker: more than one must be clarified, not truncated. */
export const SINGLE_SYMBOL_ONLY: ReadonlySet<IntentName> = new Set<IntentName>([
  'ALERT_CREATE',
  'STOCK_QUESTION',
]);

const range = z
  .object({ gt: z.number().finite().optional(), lt: z.number().finite().optional() })
  .strict();
const ScreenCriteriaSchema = z
  .object({
    changePercent: range.optional(),
    volumeRatio: range.optional(),
    rsi: range.optional(),
    priceAboveMa: z.union([z.literal(20), z.literal(50), z.literal(200)]).optional(),
    priceBelowMa: z.union([z.literal(20), z.literal(50), z.literal(200)]).optional(),
    momentum: z.enum(['positive', 'negative']).optional(),
    sort: z
      .enum(['changePercent_desc', 'changePercent_asc', 'volumeRatio_desc', 'rsi_asc', 'rsi_desc'])
      .optional(),
  })
  .strict();

const TOPICS: ReadonlySet<string> = new Set<TechnicalTopic>([
  'rsi',
  'macd',
  'ma',
  'bollinger',
  'atr',
  'volume',
  'support',
  'resistance',
]);

/**
 * Intents that change the user's data. A 4B model's reading of a vague message must never execute one of
 * these: they only run when the deterministic rules matched an explicit command.
 */
export const STATE_CHANGING: ReadonlySet<IntentName> = new Set<IntentName>([
  'WATCHLIST_ADD',
  'WATCHLIST_REMOVE',
  'ALERT_CREATE',
  'ALERT_DELETE',
  'ALERT_PAUSE',
  'ALERT_RESUME',
  'PORTFOLIO_RECORD',
  'PORTFOLIO_UNDO',
  'CONTEXT_CLEAR',
  'PREFERENCE_SET',
  'PREFERENCE_CLEAR',
  'DATA_DELETE',
  'NOTE_ADD',
  'NOTE_DELETE',
]);

export const AI_STATE_CHANGE_REFUSED =
  'Saya tidak mengubah watchlist atau alert dari kalimat yang kurang jelas. Tulis perintahnya langsung, mis. "tambah BBCA ke watchlist", "ingatkan saya kalau BBCA di atas 8500", atau "hapus alert 1".';

/**
 * AI-classified intents carry model-written parameters. Only values that pass a strict schema
 * survive; everything else is dropped so malformed values can never reach a handler.
 */
function sanitizeAiParameters(intent: ParsedIntent): Record<string, unknown> {
  const p = intent.parameters ?? {};
  switch (intent.intent) {
    case 'STOCK_SCREEN': {
      const parsed = ScreenCriteriaSchema.safeParse(p.criteria);
      return { criteria: parsed.success ? parsed.data : {} };
    }
    case 'STOCK_TECHNICAL':
      return {
        topics: Array.isArray(p.topics) ? p.topics.filter((t) => TOPICS.has(String(t))) : [],
      };
    case 'ALERT_PAUSE':
    case 'ALERT_RESUME':
    case 'ALERT_DELETE': {
      const idx = Number(p.index);
      return {
        all: p.all === true,
        index: Number.isInteger(idx) && idx >= 1 && idx <= 999 ? idx : undefined,
      };
    }
    case 'STOCK_ADVICE': {
      const k = ['trade', 'target_price', 'prediction', 'guarantee'].includes(String(p.adviceKind))
        ? p.adviceKind
        : 'trade';
      return { adviceKind: k };
    }
    case 'SMALL_TALK':
      return { kind: ['greeting', 'thanks', 'ack'].includes(String(p.kind)) ? p.kind : 'ack' };
    case 'STOCK_QUESTION':
    case 'GENERAL_QUESTION':
      return { question: typeof p.question === 'string' ? p.question.slice(0, 280) : intent.text };
    case 'ALERT_CREATE':
      return p; // validated field by field below
    default:
      return {}; // e.g. STOCK_HISTORICAL: the model never supplies dates
  }
}

/**
 * Validates and sanitizes an intent before it reaches business logic (rule-based or AI-produced).
 * Never throws; downgrades to UNKNOWN or attaches a clarification question.
 */
export function validateIntent(intent: ParsedIntent): ParsedIntent {
  const symbols = [
    ...new Set(
      intent.symbols.map((s) => normalizeTicker(s)).filter((s): s is string => s !== null),
    ),
  ].slice(0, HARD_SYMBOL_CAP);
  if (intent.source === 'ai' && STATE_CHANGING.has(intent.intent)) {
    return {
      ...intent,
      intent: 'UNKNOWN',
      symbols,
      parameters: {},
      confidence: 'low',
      clarification: AI_STATE_CHANGE_REFUSED,
    };
  }
  const out: ParsedIntent = {
    ...intent,
    symbols,
    parameters: intent.source === 'ai' ? sanitizeAiParameters(intent) : intent.parameters,
  };

  switch (out.intent) {
    case 'ALERT_CREATE': {
      const p = out.parameters as { metric?: unknown; condition?: unknown; value?: unknown };
      const metric = (['price', 'rsi', 'volume', 'ma'] as AlertMetric[]).includes(
        p.metric as AlertMetric,
      )
        ? (p.metric as AlertMetric)
        : undefined;
      const condition = (['above', 'below'] as AlertCondition[]).includes(
        p.condition as AlertCondition,
      )
        ? (p.condition as AlertCondition)
        : undefined;
      // a crossover alert has no threshold: its value is fixed to 0
      const value =
        metric === 'ma'
          ? 0
          : typeof p.value === 'number' && Number.isFinite(p.value) && p.value > 0
            ? p.value
            : undefined;
      out.parameters = { metric, condition, value };
      const bad: string[] = [];
      if (!metric) bad.push('metric');
      if (!condition) bad.push('condition');
      if (value === undefined) bad.push('value');
      if (metric === 'rsi' && value !== undefined && value > 100) bad.push('rsi>100');
      if (bad.length > 0) {
        out.confidence = 'low';
        out.clarification =
          out.clarification ??
          'Mohon lengkapi alert: sebutkan kondisi dan angkanya, mis. "ingatkan saya kalau BBCA di atas 8500".';
      }
      break;
    }
    case 'STOCK_COMPARISON':
      if (symbols.length < 2) {
        out.confidence = 'low';
        out.clarification =
          out.clarification ?? 'Sebutkan minimal dua saham, mis. "bandingkan BBCA BBRI".';
      }
      break;
    default:
      break;
  }
  return out;
}
