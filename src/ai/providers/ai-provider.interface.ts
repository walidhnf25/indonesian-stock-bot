export interface AIGenerateRequest {
  system: string;
  prompt: string;
  /** Ask the model for a single JSON object. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AIProviderHealth {
  available: boolean;
  detail: string;
}

export class AIUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_configured' | 'unreachable' | 'timeout' | 'bad_response' = 'unreachable',
  ) {
    super(message);
    this.name = 'AIUnavailableError';
  }
}

/** Business logic never talks to a model vendor directly; it goes through AIService -> AIProvider. */
export interface AIProvider {
  readonly name: string;
  /** Configured model id, or null when not configured. */
  readonly model: string | null;
  generate(req: AIGenerateRequest): Promise<string>;
  checkHealth(): Promise<AIProviderHealth>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
