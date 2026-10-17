import { Injectable, Logger } from '@nestjs/common';
import { AiQuotaService } from '../ai/ai-quota.service';
import { AIService } from '../ai/ai.service';
import { normalizeTicker } from '../common/utils/ticker';
import { parseIntent } from './intent-parser';
import { NEEDS_SYMBOL, validateIntent } from './intent-validator';
import { ConversationState, ParsedIntent } from './intent.types';

const AI_FALLBACK_MAX_CHARS = 280;

@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);

  constructor(
    private readonly ai: AIService,
    private readonly quota: AiQuotaService,
  ) {}

  /**
   * text -> validated structured intent.
   * 1) deterministic rules (incl. small talk, advice, temporal)  2) conversation context for
   * follow-ups  3) AI classification, ONLY for what rules cannot parse, and only when the user has
   * AI-intent budget left and the model is idle. Otherwise the user gets the help text.
   */
  async resolve(
    text: string,
    context: ConversationState | null,
    userId?: string,
  ): Promise<ParsedIntent> {
    let parsed = parseIntent(text);
    parsed = this.applyContext(parsed, context);

    if (this.shouldAskAi(parsed)) {
      const started = Date.now();
      const outcome = await this.classifyWithAi(parsed, context, userId);
      const ai = { ...outcome.meta, ms: Date.now() - started };
      parsed = outcome.intent
        ? { ...this.applyContext(outcome.intent, context), ai }
        : { ...parsed, ai };
    }
    return validateIntent(parsed);
  }

  /** Fills a missing ticker from the last conversation ("bagaimana supportnya?" -> same stock). */
  applyContext(parsed: ParsedIntent, context: ConversationState | null): ParsedIntent {
    if (!context || context.lastSymbols.length === 0) return parsed;

    if (parsed.intent === 'STOCK_COMPARISON' && parsed.symbols.length === 1) {
      const prev = context.lastSymbols.find((s) => s !== parsed.symbols[0]);
      if (prev) {
        return {
          ...parsed,
          symbols: [prev, parsed.symbols[0]],
          source: parsed.source === 'ai' ? 'ai' : 'context', // never launder an AI guess into a trusted source
          confidence: parsed.source === 'ai' ? parsed.confidence : 'high',
          clarification: undefined,
        };
      }
    }
    if (parsed.symbols.length === 0 && NEEDS_SYMBOL.has(parsed.intent)) {
      return {
        ...parsed,
        symbols: [context.lastSymbols[0]],
        source: parsed.source === 'ai' ? 'ai' : 'context',
      };
    }
    return parsed;
  }

  private shouldAskAi(p: ParsedIntent): boolean {
    if (p.text.length === 0 || p.text.length > AI_FALLBACK_MAX_CHARS) return false;
    // Text with no word in it (a single letter, punctuation, emoji only) cannot carry an intent.
    if (!/\p{L}{2,}/u.test(p.text)) return false;
    if (p.intent === 'UNKNOWN') return true;
    // A bare ticker plus words we didn't understand: let the model reinterpret.
    return p.confidence === 'low' && p.intent === 'STOCK_QUOTE' && p.text.split(/\s+/).length > 3;
  }

  private async classifyWithAi(
    p: ParsedIntent,
    context: ConversationState | null,
    userId?: string,
  ): Promise<{ intent: ParsedIntent | null; meta: NonNullable<ParsedIntent['ai']> }> {
    const health = await this.ai.checkHealth();
    if (!health.available) return { intent: null, meta: { skipped: 'unavailable' } };
    // Classification is a fallback, not a feature: it has its own small per-user budget.
    if (userId && !(await this.quota.tryUse(userId, 'intent'))) {
      return { intent: null, meta: { skipped: 'quota' } };
    }
    const res = await this.ai.classifyIntent(p.text, context?.lastSymbols ?? [], {
      userKey: userId,
    });
    if (!res.ok) {
      const busy = res.reason === 'busy' || res.reason === 'user_busy';
      return { intent: null, meta: { skipped: busy ? 'busy' : 'failed' } };
    }
    const { intent, symbols, parameters } = res.value;
    if (intent === 'UNKNOWN') return { intent: null, meta: { skipped: 'empty' } };
    const clean = symbols.map((s) => normalizeTicker(s)).filter((s): s is string => s !== null);
    // The model may only use tickers present in the text or conversation context.
    const upperText = p.text.toUpperCase();
    const allowed = clean.filter((s) => upperText.includes(s) || context?.lastSymbols.includes(s));
    this.logger.debug(JSON.stringify({ evt: 'ai_intent', intent, symbols: allowed }));
    return {
      intent: {
        intent,
        symbols: allowed,
        parameters: parameters as Record<string, unknown>,
        confidence: 'low',
        source: 'ai',
        text: p.text,
      },
      meta: {},
    };
  }
}
