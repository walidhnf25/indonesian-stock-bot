import { Logger } from '@nestjs/common';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  readJsonBounded,
  ResponseTooLargeError,
} from '../common/utils/bounded-http';

/**
 * Text -> fixed-length vector. Business logic never talks to an embedding vendor directly: it goes
 * through this interface, so the model can be swapped (or absent) without touching retrieval.
 */
export interface EmbeddingProvider {
  readonly name: string;
  /** Model identifier stored next to every vector; vectors from different models are never compared. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  checkHealth(): Promise<{ available: boolean; detail: string }>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

/** Unit-length copy of `v` (a zero vector stays zero). */
export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  return n === 0 ? v.slice() : v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** FNV-1a 32-bit hash: cheap, deterministic, good enough to spread features over buckets. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const HASHING_DIMENSIONS = 256;

/** Lower-case, ASCII-fold the common Indonesian diacritics, keep letters/digits, collapse whitespace. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * Deterministic, dependency-free embedding: feature hashing of word unigrams, word bigrams and
 * character trigrams into HASHING_DIMENSIONS signed buckets, L2-normalised. It needs no model, gives the
 * same vector on every machine (tests, CI, a laptop without Ollama) and captures lexical similarity
 * (misspellings, affixes: "menghitung" ~ "hitung"). It does not capture meaning; that is what a real
 * embedding model adds, which is why the hybrid search keeps the lexical channel whichever model is used.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hashing';
  readonly model = `hashing-v1-${HASHING_DIMENSIONS}`;
  readonly dimensions = HASHING_DIMENSIONS;

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.one(t)));
  }

  checkHealth(): Promise<{ available: boolean; detail: string }> {
    return Promise.resolve({ available: true, detail: 'deterministic hashing embedding' });
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      const sign = h & 1 ? 1 : -1;
      v[(h >>> 1) % this.dimensions] += sign * weight;
    };
    const words = tokenize(text);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      add(`w:${w}`, 1);
      if (i > 0) add(`b:${words[i - 1]}_${w}`, 0.5);
      const padded = `_${w}_`;
      for (let j = 0; j + 3 <= padded.length; j++) add(`c:${padded.slice(j, j + 3)}`, 0.25);
    }
    return normalize(v);
  }
}

export interface OllamaEmbeddingOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  /** Largest response body accepted. */
  maxResponseBytes?: number;
}

/**
 * Ollama `/api/embed` (any embedding model pulled locally, e.g. nomic-embed-text, bge-m3). The
 * dimension is configured, not discovered: a vector of the wrong length is rejected here rather than
 * stored, so one misconfiguration cannot mix spaces in the table.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaEmbeddingProvider.name);

  constructor(private readonly opts: OllamaEmbeddingOptions) {}

  get model(): string {
    return `ollama:${this.opts.model}`;
  }

  get dimensions(): number {
    return this.opts.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model, input: texts, keep_alive: '30m' }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new EmbeddingUnavailableError(`Ollama embed unreachable: ${(e as Error).name}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new EmbeddingUnavailableError(`Ollama embed HTTP ${res.status}`);
    }
    let body: { embeddings?: unknown };
    try {
      body = (await readJsonBounded(
        res,
        this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      )) as { embeddings?: unknown };
    } catch (e) {
      throw new EmbeddingUnavailableError(
        e instanceof ResponseTooLargeError
          ? 'Ollama embed: response too large'
          : `Ollama embed: unreadable response (${(e as Error).name})`,
      );
    }
    const out = body.embeddings;
    if (!Array.isArray(out) || out.length !== texts.length) {
      throw new EmbeddingUnavailableError('Ollama embed: malformed response');
    }
    return out.map((v) => {
      if (!Array.isArray(v) || v.length !== this.opts.dimensions || !v.every(Number.isFinite)) {
        throw new EmbeddingUnavailableError(
          `Ollama embed: expected ${this.opts.dimensions} dimensions, got ${Array.isArray(v) ? v.length : typeof v}`,
        );
      }
      return normalize(v as number[]);
    });
  }

  async checkHealth(): Promise<{ available: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { available: false, detail: `HTTP ${res.status}` };
      const body = (await readJsonBounded(
        res,
        this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      )) as { models?: Array<{ name?: string }> };
      const names = (body.models ?? []).map((m) => m.name ?? '');
      const found = names.some((n) => n === this.opts.model || n.startsWith(`${this.opts.model}:`));
      return found
        ? { available: true, detail: `model ${this.opts.model} present` }
        : { available: false, detail: `model ${this.opts.model} not pulled` };
    } catch (e) {
      this.logger.debug(`embedding health failed: ${(e as Error).name}`);
      return { available: false, detail: 'unreachable' };
    }
  }
}
