import { Injectable } from '@nestjs/common';
import { DISCLAIMER } from '../../ai/prompts/prompts';
import { escapeHtml as h } from '../../common/utils/format';
import { detectAdviceKind } from '../../intent/parsers/conversational-parser';
import { GLOSSARY_FALLBACK, findGlossaryEntries } from '../../knowledge/glossary';
import { NOTE_MAX_PER_USER, RagService, RetrievedChunk } from '../../rag/rag.service';
import { adviceMessage } from '../../telegram/policy-messages';
import { HandlerContext } from '../chat.types';

/** Notes are personal: never shown, added or deleted from a group. */
export const NOTES_PRIVATE_ONLY =
  'Catatan bersifat pribadi, jadi hanya bisa dibuat atau dilihat lewat chat pribadi dengan bot ini.';

/**
 * Conceptual questions and personal notes, answered from retrieval only.
 *
 * Order for a conceptual question: (1) the deterministic glossary (exact topic match, unchanged
 * behaviour), (2) hybrid retrieval over the application corpus and, in a private chat, the user's
 * own notes, (3) the fixed fallback. The language model is never involved: every sentence shown is
 * application-authored or the user's own note, HTML-escaped.
 */
@Injectable()
export class KnowledgeHandler {
  constructor(private readonly rag: RagService) {}

  async general(ctx: HandlerContext): Promise<string[]> {
    const question = (ctx.intent.parameters.question as string | undefined) ?? ctx.intent.text;
    const entries = findGlossaryEntries(question);
    ctx.log.glossary = entries.map((e) => e.id);
    const parts: string[] = entries.map((e) => `📘 <b>${h(e.title)}</b>\n${h(e.text)}`);

    if (parts.length === 0) {
      // a user's notes are only searched from their private chat (a group answer must not leak them)
      const userId = ctx.chat.type === 'private' ? ctx.user.id : null;
      const hits = await this.rag.search(question, { userId, scope: 'all', limit: 2 });
      ctx.log.rag = hits.map((x) => ({ doc: x.documentId, channels: x.channels }));
      parts.push(...hits.map((x) => renderChunk(x)));
    }
    if (parts.length === 0) parts.push(h(GLOSSARY_FALLBACK));

    const advice = detectAdviceKind(question.toLowerCase(), true);
    if (advice) {
      ctx.log.adviceKind = advice;
      parts.push(`ℹ️ ${h(adviceMessage(advice, []))}`);
    }
    return [`${parts.join('\n\n')}\n\n<i>${DISCLAIMER}</i>`];
  }

  /**
   * Last resort for a message no rule and no model understood: a corpus chunk that shares actual words with
   * the message (lexical hit) is a better answer than "I don't understand". Vector-only hits are not enough
   * here: a stray similarity must not turn an unrelated message into a lecture. Null = nothing found.
   */
  async tryUnknown(ctx: HandlerContext): Promise<string[] | null> {
    if (ctx.intent.symbols.length > 0 || !/\p{L}{3,}/u.test(ctx.intent.text)) return null;
    const userId = ctx.chat.type === 'private' ? ctx.user.id : null;
    const hits = await this.rag.search(ctx.intent.text, { userId, scope: 'all', limit: 1 });
    const hit = hits.find((x) => x.channels.includes('lexical'));
    if (!hit) return null;
    ctx.log.rag = [{ doc: hit.documentId, channels: hit.channels, fallback: true }];
    return [`${renderChunk(hit)}\n\n<i>${DISCLAIMER}</i>`];
  }

  async noteAdd(ctx: HandlerContext): Promise<string[]> {
    const text = ctx.intent.parameters.text as string | undefined;
    if (!text) return ['Tulis isi catatannya, mis. "catat: BBCA cum date 20 Mei".'];
    const note = await this.rag.addNote(ctx.user.id, text);
    return [
      `🗒️ Catatan #${note.index} disimpan: ${h(note.text)}\n\nLihat dengan "catatan saya", cari dengan "cari catatan ...", hapus dengan "hapus catatan ${note.index}". Maksimal ${NOTE_MAX_PER_USER} catatan.`,
    ];
  }

  async noteList(ctx: HandlerContext): Promise<string[]> {
    const notes = await this.rag.listNotes(ctx.user.id);
    if (notes.length === 0)
      return ['Belum ada catatan. Buat dengan "catat: ..." (maks 500 karakter).'];
    const lines = notes.map((n) => `${n.index}. ${h(n.text)}`);
    return [`🗒️ <b>Catatan kamu</b> (${notes.length}/${NOTE_MAX_PER_USER})\n${lines.join('\n')}`];
  }

  async noteDelete(ctx: HandlerContext): Promise<string[]> {
    const p = ctx.intent.parameters as { index?: number; all?: boolean };
    const removed = await this.rag.deleteNotes(ctx.user.id, p);
    if (removed.length === 0) return ['ℹ️ Tidak ada catatan dengan nomor itu.'];
    return [`🗑️ ${removed.length} catatan dihapus.`];
  }

  async noteSearch(ctx: HandlerContext): Promise<string[]> {
    const query = ctx.intent.parameters.query as string | undefined;
    if (!query) return ['Cari apa di catatanmu? Mis. "cari catatan BBCA".'];
    const hits = await this.rag.search(query, { userId: ctx.user.id, scope: 'notes', limit: 5 });
    ctx.log.rag = hits.map((x) => ({ doc: x.documentId, channels: x.channels }));
    if (hits.length === 0) return [`Tidak ada catatan yang cocok dengan "${h(query)}".`];
    const notes = await this.rag.listNotes(ctx.user.id);
    const numbered = hits.map((x) => {
      const n = notes.find((k) => k.id === x.documentId);
      return `${n ? `${n.index}. ` : '• '}${h(x.content)}`;
    });
    return [`🔎 <b>Catatan yang cocok</b>\n${numbered.join('\n')}`];
  }
}

function renderChunk(x: RetrievedChunk): string {
  if (x.scope === 'USER') return `🗒️ <b>Catatan kamu</b>\n${h(x.content)}`;
  return `📘 <b>${h(x.title)}</b>\n${h(stripTitle(x.content, x.title))}`;
}

/** Chunks carry their title for retrieval; it is shown once, as the heading. */
function stripTitle(content: string, title: string): string {
  for (const prefix of [`${title}. `, `${title} — `]) {
    if (content.startsWith(prefix)) return content.slice(prefix.length);
  }
  return content;
}
