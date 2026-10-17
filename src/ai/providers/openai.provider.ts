import {
  AIGenerateRequest,
  AIProvider,
  AIProviderHealth,
  AIUnavailableError,
} from './ai-provider.interface';
import { postJson } from './http';

export interface OpenAIOptions {
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  baseUrl?: string;
  maxResponseBytes?: number;
}

/** OpenAI Chat Completions. Requires OPENAI_API_KEY and OPENAI_MODEL. Optional, not the default. */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';

  constructor(private readonly opts: OpenAIOptions) {}

  get model(): string | null {
    return this.opts.model?.trim() || null;
  }

  async generate(req: AIGenerateRequest): Promise<string> {
    if (!this.opts.apiKey || !this.model) {
      throw new AIUnavailableError(
        'OPENAI_API_KEY / OPENAI_MODEL is not configured.',
        'not_configured',
      );
    }
    const data = (await postJson(
      `${this.opts.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`,
      {
        model: this.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 900,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      },
      {
        timeoutMs: req.timeoutMs ?? this.opts.timeoutMs,
        label: 'OpenAI',
        maxBytes: this.opts.maxResponseBytes,
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
      },
    )) as { choices?: Array<{ message?: { content?: string } }> };

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new AIUnavailableError('OpenAI returned an empty response.', 'bad_response');
    }
    return text;
  }

  checkHealth(): Promise<AIProviderHealth> {
    if (!this.opts.apiKey || !this.model) {
      return Promise.resolve({
        available: false,
        detail: 'OPENAI_API_KEY / OPENAI_MODEL belum dikonfigurasi.',
      });
    }
    return Promise.resolve({
      available: true,
      detail: `model ${this.model} dikonfigurasi (belum diuji)`,
    });
  }
}
