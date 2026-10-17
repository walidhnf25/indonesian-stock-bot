import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Metrics } from '../common/metrics.service';
import { AppConfig } from '../config/app-config.service';
import { withTimeout } from '../common/utils/retry';
import { safeErrorMessage } from '../common/utils/scrub';
import { FairGate, GateUserLimitError } from '../common/utils/fair-gate';
import {
  AnalysisOutput,
  ComparisonOutput,
  IntentOutput,
  IntentOutputSchema,
  Validation,
  extractJson,
  validateAnalysisSelection,
  validateComparisonSelection,
} from './ai-output';
import {
  BIAS_LABEL,
  STRENGTH_LABEL,
  TREND_LABEL,
  analysisClaimsOf,
  comparisonClaimsOf,
  limitationsOf,
  promptContext,
} from './claims';
import { buildComparisonPolicyContext, buildPolicyContext } from './policy/ai-policy';
import {
  ANALYSIS_SCHEMA_HINT,
  COMPARISON_SCHEMA_HINT,
  INTENT_SYSTEM_PROMPT,
  QUESTION_SCHEMA_HINT,
  SYSTEM_PROMPT,
  analysisPrompt,
  comparisonPrompt,
  correctionPrompt,
  questionPrompt,
} from './prompts/prompts';
import {
  AI_PROVIDER,
  AIProvider,
  AIProviderHealth,
  AIUnavailableError,
} from './providers/ai-provider.interface';

/** `user_busy`: this user already has their fair share of AI work running/queued. */
export type AIFailureReason =
  'unavailable' | 'invalid' | 'unsafe' | 'timeout' | 'busy' | 'user_busy';

/** Who the AI work is for. Capacity is shared fairly between distinct keys. */
export interface AICallOptions {
  userKey?: string;
}

const ANONYMOUS_USER = 'anonymous';

export interface AIMeta {
  provider: string;
  model: string | null;
  /** Time spent generating (excludes queue wait). */
  latencyMs: number;
  /** Time spent waiting for a free AI slot. */
  queueWaitMs: number;
}

export type AIResult<T> =
  | ({ ok: true; value: T; attempts: number } & AIMeta)
  | { ok: false; reason: AIFailureReason; detail: string };

export interface AIServiceOptions {
  maxConcurrent: number;
  /** How many of the running slots one user may hold at once. */
  maxConcurrentPerUser: number;
  maxQueue: number;
  /** How many waiting requests one user may have. */
  maxQueuePerUser: number;
  queueWaitTimeoutMs: number;
  timeoutMs: number;
  intentTimeoutMs: number;
  /** Longest question text (chars) forwarded to the model. */
  questionMaxChars: number;
}

const DEFAULT_OPTIONS: AIServiceOptions = {
  maxConcurrent: 1,
  maxConcurrentPerUser: 1,
  maxQueue: 3,
  maxQueuePerUser: 1,
  queueWaitTimeoutMs: 60_000,
  timeoutMs: 90_000,
  intentTimeoutMs: 10_000,
  questionMaxChars: 300,
};

/** A healthy result is trusted for a while; an unhealthy one is re-probed quickly. */
const HEALTH_TTL_MS = 30_000;
const UNHEALTHY_TTL_MS = 5_000;

class AIFailure extends Error {
  constructor(
    readonly reason: 'unavailable' | 'timeout',
    detail: string,
  ) {
    super(detail);
  }
}

@Injectable()
export class AIService {
  private readonly logger = new Logger(AIService.name);
  private readonly opts: AIServiceOptions;
  /**
   * Process-local concurrency gate with a bounded wait queue and per-user fairness (a single local
   * Ollama instance). Not shared between processes; see README "AI limits".
   */
  private readonly gate: FairGate;
  private health?: { at: number; value: AIProviderHealth };

  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AIProvider,
    @Optional() config?: AppConfig,
    @Optional() options?: Partial<AIServiceOptions>,
    @Optional() private readonly metrics?: Metrics,
  ) {
    this.opts = {
      ...DEFAULT_OPTIONS,
      ...(config
        ? {
            maxConcurrent: config.get('AI_MAX_CONCURRENT_REQUESTS'),
            maxConcurrentPerUser: config.get('AI_MAX_CONCURRENT_PER_USER'),
            maxQueue: config.get('AI_MAX_QUEUE_DEPTH'),
            maxQueuePerUser: config.get('AI_MAX_QUEUE_PER_USER'),
            queueWaitTimeoutMs: config.get('AI_QUEUE_WAIT_TIMEOUT_MS'),
            timeoutMs: config.get('AI_TIMEOUT_MS'),
            intentTimeoutMs: config.get('AI_INTENT_TIMEOUT_MS'),
            questionMaxChars: config.get('AI_QUESTION_MAX_CHARS'),
          }
        : {}),
      ...(options ?? {}),
    };
    this.gate = new FairGate({
      permits: this.opts.maxConcurrent,
      perUser: this.opts.maxConcurrentPerUser,
      maxQueue: this.opts.maxQueue,
      maxQueuePerUser: this.opts.maxQueuePerUser,
    });
  }

  get providerName(): string {
    return this.provider.name;
  }

  get modelName(): string | null {
    return this.provider.model;
  }

  /** Requests currently waiting for a slot (for logs/health). */
  get queueDepth(): number {
    return this.gate.waiting;
  }

  async checkHealth(force = false): Promise<AIProviderHealth> {
    if (!force && this.health) {
      const ttl = this.health.value.available ? HEALTH_TTL_MS : UNHEALTHY_TTL_MS;
      if (Date.now() - this.health.at < ttl) return this.health.value;
    }
    let value: AIProviderHealth;
    try {
      value = await this.provider.checkHealth();
    } catch (e) {
      value = { available: false, detail: safeErrorMessage(e) };
    }
    this.health = { at: Date.now(), value };
    return value;
  }

  /**
   * Single-stock analysis, or a data-grounded answer to a question about it.
   * `context` is the exact structured object sent to the model; the same object defines which
   * numbers/claims the output may contain (see ai-policy).
   */
  async analyze(
    context: unknown,
    question?: string,
    call: AICallOptions = {},
  ): Promise<AIResult<AnalysisOutput>> {
    // The model picks ids from this catalogue; the application renders them: no model prose
    // can reach the user, so there is nothing for a phrase list to miss.
    const claims = analysisClaimsOf(context);
    const limitations = limitationsOf(context);
    const policy = buildPolicyContext(context);
    // Prompt size is bounded: only the first AI_QUESTION_MAX_CHARS of the question reach the model.
    if (question && question.length > this.opts.questionMaxChars) {
      question = question.slice(0, this.opts.questionMaxChars);
    }
    // The question only influences WHICH ids are chosen; it is never echoed back.
    const contextJson = promptContext(context, claims);
    const res = await this.structured({
      prompt: question ? questionPrompt(contextJson, question) : analysisPrompt(contextJson),
      schemaHint: question ? QUESTION_SCHEMA_HINT : ANALYSIS_SCHEMA_HINT,
      validate: (raw) => validateAnalysisSelection(raw, claims, limitations, policy),
      maxTokens: 120,
      userKey: call.userKey,
    });
    if (res.ok) {
      // trend/momentum are classifications computed by the application, never by the model.
      const c = context as {
        technical?: { trend?: string; momentum?: { strength?: string; bias?: string } };
      };
      res.value.trend = TREND_LABEL[c?.technical?.trend ?? ''] ?? '';
      const m = c?.technical?.momentum;
      res.value.momentum = m
        ? `${STRENGTH_LABEL[m.strength ?? ''] ?? ''} (${BIAS_LABEL[m.bias ?? ''] ?? ''})`
        : '';
    }
    return res;
  }

  compare(entries: unknown, call: AICallOptions = {}): Promise<AIResult<ComparisonOutput>> {
    // Same contract as analysis: factual comparison rows are written by the application.
    const claims = comparisonClaimsOf(entries);
    const policy = buildComparisonPolicyContext(entries);
    return this.structured({
      prompt: comparisonPrompt(JSON.stringify({ entries, claims })),
      schemaHint: COMPARISON_SCHEMA_HINT,
      validate: (raw) => validateComparisonSelection(raw, claims, policy),
      maxTokens: 120,
      userKey: call.userKey,
    });
  }

  /**
   * AI-assisted intent classification: a fallback for messages the rules could not parse.
   * Deliberately NON-BLOCKING: if the model is busy it is skipped (the user gets the help text)
   * rather than queueing behind real analyses.
   */
  async classifyIntent(
    text: string,
    lastSymbols: string[],
    call: AICallOptions = {},
  ): Promise<AIResult<IntentOutput>> {
    const prompt = `lastSymbols: ${JSON.stringify(lastSymbols)}\nmessage: ${JSON.stringify(text)}`;
    const slot = this.takeSlot(call.userKey ?? ANONYMOUS_USER);
    if (!slot.ok) return { ok: false, reason: 'busy', detail: slot.detail };
    try {
      const gen = await this.generate(
        { system: INTENT_SYSTEM_PROMPT, prompt, json: true, maxTokens: 120 },
        this.opts.intentTimeoutMs,
        slot.queueWaitMs,
      );
      const parsed = IntentOutputSchema.safeParse(extractJson(gen.raw));
      if (!parsed.success) return { ok: false, reason: 'invalid', detail: 'intent JSON invalid' };
      return { ...gen.meta, ok: true, value: parsed.data, attempts: 1 };
    } catch (e) {
      return this.toFailure(e, 'intent');
    } finally {
      slot.release();
    }
  }

  /* ---------------------------------------------------------------- internals */

  /**
   * Structured observability for a rejected model output. Logs the rule categories (policy) or a
   * short schema reason (invalid), never the model text, the prompt or the user's message.
   */
  private logRejection(attempt: number, v: Extract<Validation<unknown>, { ok: false }>): void {
    const evt =
      v.kind === 'unsafe'
        ? {
            evt: 'AI_POLICY_REJECTED',
            attempt,
            categories: [...new Set((v.violations ?? []).map((x) => x.category))],
          }
        : { evt: 'AI_OUTPUT_INVALID', attempt, reason: v.error.slice(0, 160) };
    this.logger.warn(JSON.stringify(evt));
  }

  /**
   * Generate -> validate -> (one stricter retry) -> give up. Both attempts share ONE queue slot,
   * so a retry never waits behind other users.
   */
  private async structured<T>(args: {
    prompt: string;
    schemaHint: string;
    validate: (raw: string) => Validation<T>;
    maxTokens: number;
    userKey?: string;
  }): Promise<AIResult<T>> {
    const slot = await this.waitForSlot(args.userKey ?? ANONYMOUS_USER);
    if (!slot.ok) return { ok: false, reason: slot.reason, detail: slot.detail };
    try {
      const first = await this.generate(
        { system: SYSTEM_PROMPT, prompt: args.prompt, json: true, maxTokens: args.maxTokens },
        this.opts.timeoutMs,
        slot.queueWaitMs,
      );
      const v1 = args.validate(first.raw);
      if (v1.ok) return { ...first.meta, ok: true, value: v1.value, attempts: 1 };
      this.logRejection(1, v1);

      const second = await this.generate(
        {
          system: SYSTEM_PROMPT,
          prompt: `${args.prompt}\n\n${correctionPrompt(v1.error, args.schemaHint)}`,
          json: true,
          maxTokens: args.maxTokens,
        },
        this.opts.timeoutMs,
        slot.queueWaitMs,
      );
      const v2 = args.validate(second.raw);
      if (v2.ok) {
        return {
          ...second.meta,
          ok: true,
          value: v2.value,
          attempts: 2,
          latencyMs: first.meta.latencyMs + second.meta.latencyMs,
        };
      }
      this.logRejection(2, v2);
      return { ok: false, reason: v2.kind, detail: v2.error };
    } catch (e) {
      return this.toFailure(e, 'structured');
    } finally {
      slot.release();
    }
  }

  /** Non-blocking: a slot right now, or nothing. */
  private takeSlot(
    userKey: string,
  ): { ok: true; release: () => void; queueWaitMs: number } | { ok: false; detail: string } {
    const release = this.gate.tryAcquire(userKey);
    return release ? { ok: true, release, queueWaitMs: 0 } : { ok: false, detail: 'AI is busy' };
  }

  private async waitForSlot(
    userKey: string,
  ): Promise<
    | { ok: true; release: () => void; queueWaitMs: number }
    | { ok: false; reason: 'busy' | 'user_busy'; detail: string }
  > {
    const started = Date.now();
    try {
      const release = await this.gate.acquire(userKey, { timeoutMs: this.opts.queueWaitTimeoutMs });
      return { ok: true, release, queueWaitMs: Date.now() - started };
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'queue error';
      const reason = e instanceof GateUserLimitError ? 'user_busy' : 'busy';
      this.logger.warn(
        JSON.stringify({
          evt: 'AI_USER_CONCURRENCY_LIMIT',
          reason,
          queueDepth: this.gate.waiting,
          detail,
        }),
      );
      return { ok: false, reason, detail };
    }
  }

  /** One provider call with a hard deadline, so Telegram requests can never hang. */
  private async generate(
    req: { system: string; prompt: string; json?: boolean; maxTokens?: number },
    timeoutMs: number,
    queueWaitMs: number,
  ): Promise<{ raw: string; meta: AIMeta }> {
    const started = Date.now();
    try {
      const raw = await withTimeout(
        this.provider.generate({ ...req, temperature: 0.2, timeoutMs }),
        timeoutMs + 2_000, // backstop in case a provider ignores its own timeout
        'AI call',
      );
      const latencyMs = Date.now() - started;
      this.metrics?.observe('ai_latency_ms', latencyMs, { outcome: 'ok' });
      this.metrics?.inc('ai_calls_total', { outcome: 'ok' });
      this.health = { at: Date.now(), value: { available: true, detail: 'ok' } };
      return {
        raw,
        meta: { provider: this.provider.name, model: this.provider.model, latencyMs, queueWaitMs },
      };
    } catch (e) {
      const detail = safeErrorMessage(e);
      const timedOut =
        (e instanceof AIUnavailableError && e.kind === 'timeout') || /timed out/i.test(detail);
      this.metrics?.observe('ai_latency_ms', Date.now() - started, {
        outcome: timedOut ? 'timeout' : 'error',
      });
      this.metrics?.inc('ai_calls_total', { outcome: timedOut ? 'timeout' : 'error' });
      this.logger.warn(
        `AI call failed (${this.provider.name}${timedOut ? ', timeout' : ''}): ${detail}`,
      );
      // Only a real outage (connection refused, model not configured) flips the SHARED health flag,
      // and only briefly (UNHEALTHY_TTL_MS). A slow call or a bad response says nothing about
      // whether other users' requests will work, so it must not switch AI off for everybody.
      if (
        e instanceof AIUnavailableError &&
        (e.kind === 'unreachable' || e.kind === 'not_configured')
      ) {
        this.health = { at: Date.now(), value: { available: false, detail } };
      }
      throw new AIFailure(timedOut ? 'timeout' : 'unavailable', detail);
    }
  }

  private toFailure(
    e: unknown,
    where: string,
  ): { ok: false; reason: AIFailureReason; detail: string } {
    if (e instanceof AIFailure) return { ok: false, reason: e.reason, detail: e.message };
    const detail = safeErrorMessage(e);
    this.logger.error(`AI ${where} failed unexpectedly: ${detail}`);
    return { ok: false, reason: 'unavailable', detail };
  }
}
