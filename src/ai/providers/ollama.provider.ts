import { safeErrorMessage } from '../../common/utils/scrub';
import {
  AIGenerateRequest,
  AIProvider,
  AIProviderHealth,
  AIUnavailableError,
} from './ai-provider.interface';
import { DEFAULT_MAX_RESPONSE_BYTES, readJsonBounded } from '../../common/utils/bounded-http';
import { postJson } from './http';

export interface OllamaOptions {
  baseUrl: string;
  model?: string;
  timeoutMs: number;
  /** Largest response body accepted. */
  maxResponseBytes?: number;
}

/** Local Ollama provider (default). Talks to /api/chat with streaming disabled. */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';

  constructor(private readonly opts: OllamaOptions) {}

  get model(): string | null {
    return this.opts.model?.trim() || null;
  }

  async generate(req: AIGenerateRequest): Promise<string> {
    if (!this.model) {
      throw new AIUnavailableError('OLLAMA_MODEL is not configured.', 'not_configured');
    }
    const data = (await postJson(
      `${this.opts.baseUrl}/api/chat`,
      {
        model: this.model,
        stream: false,
        keep_alive: '30m', // keep the model in memory between requests (avoids slow reloads)
        // Reasoning models (e.g. qwen3 "thinking") would otherwise spend the budget on hidden thoughts.
        think: false,
        ...(req.json ? { format: 'json' } : {}),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        options: {
          temperature: req.temperature ?? 0.2,
          num_predict: req.maxTokens ?? 900,
          num_ctx: 4096,
        },
      },
      {
        timeoutMs: req.timeoutMs ?? this.opts.timeoutMs,
        label: 'Ollama',
        maxBytes: this.opts.maxResponseBytes,
      },
    )) as { message?: { content?: string } };

    const content = data?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new AIUnavailableError('Ollama returned an empty response.', 'bad_response');
    }
    return content;
  }

  async checkHealth(): Promise<AIProviderHealth> {
    if (!this.model) {
      return { available: false, detail: 'OLLAMA_MODEL belum dikonfigurasi.' };
    }
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { available: false, detail: `Ollama HTTP ${res.status}` };
      const body = (await readJsonBounded(
        res,
        this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      )) as { models?: Array<{ name?: string; model?: string }> };
      const names = (body.models ?? []).map((m) => m.name ?? m.model ?? '');
      const wanted = this.model;
      const found = names.some((n) => n === wanted || n === `${wanted}:latest`);
      return found
        ? { available: true, detail: `model ${wanted} siap` }
        : {
            available: false,
            detail: `model ${wanted} belum diunduh (jalankan: ollama pull ${wanted})`,
          };
    } catch (e) {
      return {
        available: false,
        // the base URL is deliberately not repeated: /health shows this text and the URL may carry credentials
        detail: `Ollama tidak terjangkau: ${safeErrorMessage(e)}`,
      };
    }
  }
}
