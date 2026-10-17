import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { QUOTA_STORE } from '../stock/governance/market-data-governor';
import { QuotaStore } from '../stock/governance/quota-store';

export type AiQuotaKind = 'analysis' | 'intent';

/**
 * Per-user budget for AI calls so one user cannot monopolise the local model. Two independent
 * buckets: "analysis" (analysis, questions, comparison notes, conceptual answers) and "intent"
 * (AI intent classification, which is a fallback and must stay cheap). Shared across processes when Redis
 * is configured (QuotaStore), per process otherwise.
 */
@Injectable()
export class AiQuotaService {
  private readonly limits: Record<AiQuotaKind, number>;

  constructor(
    config: AppConfig,
    @Inject(QUOTA_STORE) private readonly store: QuotaStore,
  ) {
    this.limits = {
      analysis: config.get('AI_ANALYSIS_MAX_REQUESTS_PER_USER_PER_MINUTE'),
      intent: config.get('AI_INTENT_MAX_REQUESTS_PER_USER_PER_MINUTE'),
    };
  }

  /** Consumes one unit. Resolves false when the user is over budget. */
  async tryUse(userId: string, kind: AiQuotaKind): Promise<boolean> {
    return (await this.store.consume(`ai:${kind}`, userId, this.limits[kind], 60_000)).allowed;
  }
}
