import {
  AIGenerateRequest,
  AIProvider,
  AIProviderHealth,
  AIUnavailableError,
} from './ai-provider.interface';
import { postJson } from './http';

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  maxResponseBytes?: number;
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Google Gemini (REST). Requires GEMINI_API_KEY and GEMINI_MODEL. Optional, not the default. */
export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';

  constructor(private readonly opts: GeminiOptions) {}

  get model(): string | null {
    return this.opts.model?.trim() || null;
  }

  async generate(req: AIGenerateRequest): Promise<string> {
    if (!this.opts.apiKey || !this.model) {
      throw new AIUnavailableError(
        'GEMINI_API_KEY / GEMINI_MODEL is not configured.',
        'not_configured',
      );
    }
    const data = (await postJson(
      `${BASE}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature ?? 0.2,
          maxOutputTokens: req.maxTokens ?? 900,
          ...(req.json ? { responseMimeType: 'application/json' } : {}),
        },
      },
      {
        timeoutMs: req.timeoutMs ?? this.opts.timeoutMs,
        label: 'Gemini',
        maxBytes: this.opts.maxResponseBytes,
        // Key goes in a header, never in the URL, so it cannot leak through logs.
        headers: { 'x-goog-api-key': this.opts.apiKey },
      },
    )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim())
      throw new AIUnavailableError('Gemini returned an empty response.', 'bad_response');
    return text;
  }

  checkHealth(): Promise<AIProviderHealth> {
    if (!this.opts.apiKey || !this.model) {
      return Promise.resolve({
        available: false,
        detail: 'GEMINI_API_KEY / GEMINI_MODEL belum dikonfigurasi.',
      });
    }
    // Avoid spending quota on health probes: configuration present = considered available.
    return Promise.resolve({
      available: true,
      detail: `model ${this.model} dikonfigurasi (belum diuji)`,
    });
  }
}
