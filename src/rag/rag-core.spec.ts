import { chunkText, splitSentences } from './chunker';
import {
  cosine,
  HASHING_DIMENSIONS,
  HashingEmbeddingProvider,
  OllamaEmbeddingProvider,
  tokenize,
} from './embedding.provider';
import { reciprocalRankFusion } from './fusion';
import { queryTerms } from './rag.service';

describe('Hashing embedding (deterministic fallback)', () => {
  const p = new HashingEmbeddingProvider();

  it('is deterministic, unit-length and of the declared dimension', async () => {
    const [a, b] = await p.embed([
      'RSI adalah indikator momentum.',
      'RSI adalah indikator momentum.',
    ]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(HASHING_DIMENSIONS);
    expect(Math.abs(cosine(a, a) - 1)).toBeLessThan(1e-9);
  });

  it('ranks lexically related text above unrelated text', async () => {
    const [q, related, unrelated] = await p.embed([
      'apa itu rsi overbought',
      'RSI di atas 70 dianggap zona jenuh beli (overbought).',
      'Dividen adalah bagian laba yang dibagikan kepada pemegang saham.',
    ]);
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });

  it('tolerates affixes and small misspellings through character trigrams', async () => {
    const [q, a, b] = await p.embed([
      'menghitung volatilitas',
      'hitung volatilitas',
      'harga penutupan',
    ]);
    expect(cosine(q, a)).toBeGreaterThan(cosine(q, b));
  });

  it('an empty text gives the zero vector and never NaN', async () => {
    const [z] = await p.embed(['']);
    expect(z.every((x) => x === 0)).toBe(true);
  });

  it('tokenize folds case, diacritics and punctuation', () => {
    expect(tokenize('Harga, Penutupan! (close) é')).toEqual(['harga', 'penutupan', 'close']);
  });
});

describe('Ollama embedding provider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const provider = () =>
    new OllamaEmbeddingProvider({
      baseUrl: 'http://ollama.test',
      model: 'm',
      dimensions: 3,
      timeoutMs: 100,
    });

  it('returns normalised vectors and rejects a wrong dimension instead of storing it', async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ embeddings: [[3, 0, 0]] }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await provider().embed(['x'])).toEqual([[1, 0, 0]]);

    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(provider().embed(['x'])).rejects.toThrow(/expected 3 dimensions/);
  });

  it('maps HTTP errors, malformed bodies and network failures to EmbeddingUnavailableError', async () => {
    global.fetch = jest.fn(
      async () => new Response('', { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(provider().embed(['x'])).rejects.toMatchObject({
      name: 'EmbeddingUnavailableError',
    });
    global.fetch = jest.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(provider().embed(['x'])).rejects.toThrow(/malformed/);
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(provider().embed(['x'])).rejects.toThrow(/unreachable/);
  });

  it('health reports whether the model has been pulled', async () => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ models: [{ name: 'm:latest' }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await provider().checkHealth()).toMatchObject({ available: true });
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ models: [{ name: 'other' }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await provider().checkHealth()).toMatchObject({
      available: false,
      detail: /not pulled/,
    });
  });
});

describe('Chunker', () => {
  it('splits sentences on terminal punctuation followed by a capital', () => {
    expect(splitSentences('Satu kalimat. Kalimat kedua! Ketiga? Angka 2.5 bukan batas.')).toEqual([
      'Satu kalimat.',
      'Kalimat kedua!',
      'Ketiga?',
      'Angka 2.5 bukan batas.',
    ]);
  });

  it('packs sentences up to maxChars, overlaps one sentence and merges a tiny tail', () => {
    const sentences = Array.from(
      { length: 12 },
      (_, i) => `Kalimat nomor ${i + 1} berisi teks uji.`,
    );
    const chunks = chunkText(sentences.join(' '), { maxChars: 120, minChars: 40 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
    // the last sentence of a chunk opens the next one
    const last = (c: string) => c.slice(c.lastIndexOf('Kalimat'));
    expect(chunks[1].startsWith(last(chunks[0]))).toBe(true);
    // deterministic
    expect(chunkText(sentences.join(' '), { maxChars: 120, minChars: 40 })).toEqual(chunks);
  });

  it('hard-splits an over-long sentence at a space and keeps paragraphs apart', () => {
    const long = 'kata '.repeat(100).trim();
    const chunks = chunkText(`${long}\n\nParagraf kedua pendek.`, { maxChars: 100, minChars: 10 });
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join(' ')).toContain('Paragraf kedua pendek.');
  });

  it('empty input gives no chunks', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});

describe('Reciprocal rank fusion', () => {
  it('puts an item ranked by both channels above one ranked first by a single channel', () => {
    const fused = reciprocalRankFusion(
      [
        { channel: 'lexical', items: ['a', 'b', 'c'] },
        { channel: 'vector', items: ['b', 'd'] },
      ],
      (s) => s,
    );
    expect(fused[0]).toMatchObject({ item: 'b', channels: ['lexical', 'vector'] });
    expect(fused.map((r) => r.item)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('is deterministic for ties', () => {
    const fused = reciprocalRankFusion(
      [
        { channel: 'x', items: ['z', 'y'] },
        { channel: 'y', items: ['y', 'z'] },
      ],
      (s) => s,
    );
    expect(fused.map((r) => r.item)).toEqual(['y', 'z']);
  });
});

describe('Query terms', () => {
  it('drops question words, connectives, emoji and bare numbers; nothing topical means nothing to search', () => {
    expect(queryTerms('PER dan PBV itu apa?')).toEqual(['per', 'pbv']);
    expect(queryTerms('apa bedanya floating dan realized')).toEqual(['floating', 'realized']);
    expect(queryTerms('apa itu?')).toEqual([]); // stop words only: nothing to retrieve
    expect(queryTerms('apa itu 🚀🚀 ✨')).toEqual([]);
    expect(queryTerms("apa itu ' OR 1=1 --")).toEqual([]);
    expect(queryTerms('')).toEqual([]);
  });
});
