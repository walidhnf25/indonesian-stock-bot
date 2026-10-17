import { Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
  HashingEmbeddingProvider,
  OllamaEmbeddingProvider,
} from './embedding.provider';
import { RagService } from './rag.service';

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  const model = config.get('EMBEDDING_MODEL');
  if (config.get('EMBEDDING_PROVIDER') === 'ollama' && model) {
    return new OllamaEmbeddingProvider({
      baseUrl: config.get('OLLAMA_BASE_URL').replace(/\/+$/, ''),
      model,
      dimensions: config.get('EMBEDDING_DIMENSIONS'),
      timeoutMs: config.get('EMBEDDING_TIMEOUT_MS'),
      maxResponseBytes: config.get('EMBEDDING_MAX_RESPONSE_BYTES'),
    });
  }
  return new HashingEmbeddingProvider();
}

@Module({
  providers: [
    { provide: EMBEDDING_PROVIDER, useFactory: createEmbeddingProvider, inject: [AppConfig] },
    RagService,
  ],
  exports: [RagService, EMBEDDING_PROVIDER],
})
export class RagModule {}
