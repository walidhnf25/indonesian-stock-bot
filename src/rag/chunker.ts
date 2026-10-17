/**
 * Deterministic text chunking for the RAG corpus: paragraphs first, then sentences, packed into chunks
 * of at most `maxChars` with one sentence of overlap between neighbours so a fact split across a
 * boundary is still retrievable. The same input always yields the same chunks (stable ids and vectors).
 */
export interface ChunkOptions {
  maxChars: number;
  /** Chunks shorter than this are merged into the previous one. */
  minChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 700, minChars: 120 };

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"“(])/;

export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function chunkText(text: string, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): string[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = '';
  let lastSentence = '';
  const flush = () => {
    if (current.trim().length === 0) return;
    chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    for (const sentence of splitSentences(paragraph)) {
      const pieces =
        sentence.length > opts.maxChars ? hardSplit(sentence, opts.maxChars) : [sentence];
      for (const piece of pieces) {
        if (current.length > 0 && current.length + 1 + piece.length > opts.maxChars) {
          flush();
          // overlap: start the next chunk with the sentence that closed the previous one
          if (lastSentence && lastSentence.length + 1 + piece.length <= opts.maxChars) {
            current = lastSentence;
          }
        }
        current = current.length === 0 ? piece : `${current} ${piece}`;
        lastSentence = piece;
      }
    }
  }
  flush();

  // a trailing fragment that is too short to stand alone goes back into its predecessor
  if (chunks.length > 1 && chunks[chunks.length - 1].length < opts.minChars) {
    const tail = chunks.pop() as string;
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${tail}`;
  }
  return chunks;
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(' ', max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}
