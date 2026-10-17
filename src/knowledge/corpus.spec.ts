import { GENERAL_ANSWER_POLICY, checkTextPolicy } from '../ai/policy/ai-policy';
import { chunkText } from '../rag/chunker';
import { GLOSSARY } from './glossary';
import { KNOWLEDGE_CORPUS } from './corpus';

/** The corpus is application-authored text; it must be as safe as the glossary it extends. */
describe('knowledge corpus', () => {
  it('has unique, stable ids and includes every glossary entry', () => {
    const ids = KNOWLEDGE_CORPUS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GLOSSARY) expect(ids).toContain(`glossary-${g.id}`);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_-]+$/);
  });

  it.each(KNOWLEDGE_CORPUS.map((a) => [a.id, a] as const))(
    '%s: every chunk passes the AI output policy and contains no advice, guarantee, target or rupiah price',
    (_id, article) => {
      const chunks = chunkText(article.content);
      expect(chunks.length).toBeGreaterThan(0);
      for (const text of [article.title, article.content, ...chunks]) {
        expect(checkTextPolicy([text], GENERAL_ANSWER_POLICY)).toEqual([]);
        expect(text).not.toMatch(/\bRp\s?\d/);
        expect(text).not.toMatch(
          /\b(beli sekarang|jual sekarang|pasti naik|pasti turun|dijamin|all in|gas|target harga|rekomendasi beli|rekomendasi jual|segera beli|segera jual)\b/i,
        );
      }
    },
  );

  it('chunks stay within the chunker limit so one chunk always fits in a Telegram message', () => {
    for (const a of KNOWLEDGE_CORPUS) {
      for (const c of chunkText(a.content)) expect(c.length).toBeLessThanOrEqual(700);
    }
  });
});
