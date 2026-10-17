import { Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { AiQuotaService } from './ai-quota.service';
import { AIService } from './ai.service';
import { AI_PROVIDER, AIProvider } from './providers/ai-provider.interface';
import { GeminiProvider } from './providers/gemini.provider';
import { OllamaProvider } from './providers/ollama.provider';
import { OpenAIProvider } from './providers/openai.provider';

export function createAiProvider(config: AppConfig): AIProvider {
  const timeoutMs = config.get('AI_TIMEOUT_MS');
  switch (config.get('AI_PROVIDER')) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: config.get('GEMINI_API_KEY'),
        model: config.get('GEMINI_MODEL'),
        timeoutMs,
        maxResponseBytes: config.get('AI_MAX_RESPONSE_BYTES'),
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey: config.get('OPENAI_API_KEY'),
        model: config.get('OPENAI_MODEL'),
        timeoutMs,
        maxResponseBytes: config.get('AI_MAX_RESPONSE_BYTES'),
      });
    case 'ollama':
    default:
      return new OllamaProvider({
        baseUrl: config.get('OLLAMA_BASE_URL').replace(/\/+$/, ''),
        model: config.get('OLLAMA_MODEL'),
        timeoutMs,
        maxResponseBytes: config.get('AI_MAX_RESPONSE_BYTES'),
      });
  }
}

@Module({
  providers: [
    { provide: AI_PROVIDER, useFactory: createAiProvider, inject: [AppConfig] },
    AIService,
    AiQuotaService,
  ],
  exports: [AIService, AiQuotaService],
})
export class AIModule {}
