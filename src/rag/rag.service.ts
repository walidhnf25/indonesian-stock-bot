import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KnowledgeScope, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { sanitizeInput } from '../ai/policy/canonical';
import { UserFacingError } from '../common/exceptions/app-errors';
import { Metrics } from '../common/metrics.service';
import { safeErrorMessage } from '../common/utils/scrub';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../database/prisma.service';
import { KNOWLEDGE_CORPUS } from '../knowledge/corpus';
import { isTestRuntime } from '../telegram/runtime-guard';
import { chunkText } from './chunker';
import { EMBEDDING_PROVIDER, EmbeddingProvider, tokenize } from './embedding.provider';
import { reciprocalRankFusion } from './fusion';

export const NOTE_MAX_PER_USER = 50;
const CANDIDATES_PER_CHANNEL = 20;
const EMBED_BATCH = 32;
const CORPUS_SOURCE = 'corpus';
const NOTE_SOURCE = 'note';

export type SearchScope = 'all' | 'global' | 'notes';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  scope: KnowledgeScope;
  /** Fused score (reciprocal rank fusion); only comparable within one search. */
  score: number;
  channels: string[];
  /** Cosine similarity from the vector channel, when it ranked this chunk. */
  similarity?: number;
}

export interface NoteView {
  index: number;
  id: string;
  text: string;
  createdAt: Date;
}

interface Candidate {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  scope: KnowledgeScope;
  similarity?: number;
}

/**
 * Retrieval over an application-authored knowledge corpus plus each user's own notes.
 *
 * Authorization happens in the WHERE clause of every channel query, before any ranking: a chunk is
 * visible when its document is GLOBAL or belongs to the asking user. Nothing is filtered after the
 * fact, so a note can never influence another user's results, not even their ranking.
 *
 * Retrieval is hybrid: PostgreSQL full text (lexical channel) and pgvector cosine distance over the
 * configured embedding model (vector channel), merged with reciprocal rank fusion. The language
 * model is not involved: retrieved text is application-authored or the user's own, rendered verbatim.
 * Vectors are advisory: when the embedding provider is down the lexical channel still answers.
 */
@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private readonly enabled: boolean;
  private readonly minSimilarity: number;
  /** False when the database has no vector extension or ingestion failed; retrieval is then skipped. */
  private ready = false;
  private lastError: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: Metrics,
    private readonly config: AppConfig,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {
    this.enabled = config.get('RAG_ENABLED');
    this.minSimilarity = config.get('RAG_MIN_SIMILARITY') / 100;
  }

  get status(): { enabled: boolean; ready: boolean; embedding: string; detail: string | null } {
    return {
      enabled: this.enabled,
      ready: this.ready,
      embedding: this.embeddings.model,
      detail: this.lastError,
    };
  }

  get available(): boolean {
    return this.enabled && this.ready;
  }

  onModuleInit(): void {
    // tests ingest explicitly (a background write would race their table resets)
    if (!this.enabled || isTestRuntime() || this.config.get('NODE_ENV') === 'test') return;
    // Ingestion is idempotent and runs in the background: a slow or absent embedding model never delays
    // start-up, and the lexical channel works as soon as the chunks exist.
    void this.ingestCorpus().catch((e) => {
      this.lastError = safeErrorMessage(e);
      this.logger.warn(
        `knowledge ingestion failed; RAG disabled until next start: ${this.lastError}`,
      );
    });
  }

  /* ---------------------------------------------------------------- ingestion */

  /**
   * Upserts the application corpus (by stable id and content hash), re-chunks what changed and embeds
   * every chunk that has no vector for the current model. Safe to run repeatedly and concurrently from
   * several processes: a document is only rewritten when its hash differs.
   */
  async ingestCorpus(): Promise<{ documents: number; changed: number; embedded: number }> {
    let changed = 0;
    for (const article of KNOWLEDGE_CORPUS) {
      const content = `${article.title}\n\n${article.content}`;
      const hash = sha256(content);
      const existing = await this.prisma.knowledgeDocument.findUnique({
        where: { source_externalId: { source: CORPUS_SOURCE, externalId: article.id } },
        select: { id: true, contentHash: true },
      });
      if (existing?.contentHash === hash) continue;
      changed++;
      const chunks = chunkText(article.content).map((text, i) => ({
        ordinal: i,
        // the title travels with every chunk so a short chunk still carries its topic words
        content: i === 0 ? `${article.title}. ${text}` : `${article.title} — ${text}`,
      }));
      await this.prisma.$transaction(async (tx) => {
        const doc = await tx.knowledgeDocument.upsert({
          where: { source_externalId: { source: CORPUS_SOURCE, externalId: article.id } },
          create: {
            scope: 'GLOBAL',
            source: CORPUS_SOURCE,
            externalId: article.id,
            title: article.title,
            content: article.content,
            contentHash: hash,
          },
          update: { title: article.title, content: article.content, contentHash: hash },
        });
        await tx.knowledgeChunk.deleteMany({ where: { documentId: doc.id } });
        await tx.knowledgeChunk.createMany({
          data: chunks.map((c) => ({ documentId: doc.id, ordinal: c.ordinal, content: c.content })),
        });
      });
    }
    // Articles that left the corpus (renamed or removed) must not keep being served from an older database:
    // only the application's own GLOBAL corpus rows are pruned; user notes and every other source are never touched.
    const retired = await this.prisma.knowledgeDocument.deleteMany({
      where: {
        source: CORPUS_SOURCE,
        scope: 'GLOBAL',
        externalId: { notIn: KNOWLEDGE_CORPUS.map((article) => article.id) },
      },
    });
    this.ready = true;
    this.lastError = null;
    const embedded = await this.embedMissing();
    this.logger.log(
      JSON.stringify({
        evt: 'rag_ingest',
        documents: KNOWLEDGE_CORPUS.length,
        changed,
        retired: retired.count,
        embedded,
      }),
    );
    return { documents: KNOWLEDGE_CORPUS.length, changed, embedded };
  }

  /** Embeds chunks that have no vector for the current model (any scope). Stops at the first provider failure. */
  async embedMissing(limit = 1000): Promise<number> {
    let done = 0;
    while (done < limit) {
      const rows = await this.prisma.knowledgeChunk.findMany({
        where: {
          OR: [{ embeddingModel: null }, { embeddingModel: { not: this.embeddings.model } }],
        },
        select: { id: true, content: true },
        orderBy: { id: 'asc' },
        take: Math.min(EMBED_BATCH, limit - done),
      });
      if (rows.length === 0) break;
      let vectors: number[][];
      try {
        vectors = await this.embeddings.embed(rows.map((r) => r.content));
      } catch (e) {
        this.metrics.inc('rag_embedding_failures_total', { stage: 'ingest' });
        this.logger.warn(
          `embedding unavailable, ${rows.length}+ chunks left without vectors: ${safeErrorMessage(e)}`,
        );
        break;
      }
      for (let i = 0; i < rows.length; i++) {
        await this.storeVector(rows[i].id, vectors[i]);
      }
      done += rows.length;
    }
    return done;
  }

  private async storeVector(chunkId: string, vector: number[]): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "KnowledgeChunk"
      SET embedding = ${toVectorLiteral(vector)}::vector, "embeddingModel" = ${this.embeddings.model}
      WHERE id = ${chunkId}`;
  }

  /* ---------------------------------------------------------------- notes */

  async addNote(userId: string, text: string): Promise<NoteView> {
    const body = sanitizeInput(text).replace(/\s+/g, ' ').trim();
    if (body.length === 0) throw new UserFacingError('Catatan kosong.', 'NOTE_EMPTY');
    const count = await this.prisma.knowledgeDocument.count({
      where: { userId, source: NOTE_SOURCE },
    });
    if (count >= NOTE_MAX_PER_USER) {
      throw new UserFacingError(
        `Maksimal ${NOTE_MAX_PER_USER} catatan. Hapus yang lama dulu ("hapus catatan 1").`,
        'NOTE_LIMIT',
      );
    }
    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        scope: 'USER',
        userId,
        source: NOTE_SOURCE,
        title: body.slice(0, 60),
        content: body,
        contentHash: sha256(body),
        chunks: { create: [{ ordinal: 0, content: body }] },
      },
      include: { chunks: true },
    });
    // best effort: without a vector the note is still found lexically
    try {
      const [vector] = await this.embeddings.embed([body]);
      await this.storeVector(doc.chunks[0].id, vector);
    } catch (e) {
      this.metrics.inc('rag_embedding_failures_total', { stage: 'note' });
      this.logger.debug(`note left without vector: ${safeErrorMessage(e)}`);
    }
    const all = await this.listNotes(userId);
    return (
      all.find((n) => n.id === doc.id) ?? {
        index: all.length,
        id: doc.id,
        text: body,
        createdAt: doc.createdAt,
      }
    );
  }

  /** The user's notes, oldest first, numbered from 1 (the numbers users refer to). */
  async listNotes(userId: string): Promise<NoteView[]> {
    const rows = await this.prisma.knowledgeDocument.findMany({
      where: { userId, source: NOTE_SOURCE },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, content: true, createdAt: true },
    });
    return rows.map((r, i) => ({
      index: i + 1,
      id: r.id,
      text: r.content,
      createdAt: r.createdAt,
    }));
  }

  async deleteNotes(userId: string, sel: { index?: number; all?: boolean }): Promise<NoteView[]> {
    const notes = await this.listNotes(userId);
    const victims = sel.all ? notes : notes.filter((n) => n.index === sel.index);
    if (victims.length === 0) return [];
    // userId is part of the filter so a forged id can never delete someone else's note
    await this.prisma.knowledgeDocument.deleteMany({
      where: { userId, source: NOTE_SOURCE, id: { in: victims.map((v) => v.id) } },
    });
    return victims;
  }

  /* ---------------------------------------------------------------- search */

  async search(
    query: string,
    opts: { userId: string | null; scope?: SearchScope; limit?: number },
  ): Promise<RetrievedChunk[]> {
    if (!this.available) return [];
    const scope = opts.scope ?? 'all';
    const limit = opts.limit ?? 3;
    const q = sanitizeInput(query).slice(0, 300);
    const visible = this.visibilityFilter(scope, opts.userId);
    if (!visible) return [];
    if (queryTerms(q).length === 0) return []; // nothing topical: neither channel runs

    const searchStarted = Date.now();
    const [lexical, vector] = await Promise.all([
      this.lexicalChannel(q, visible),
      this.vectorChannel(q, visible),
    ]);
    this.metrics.observe('rag_search_ms', Date.now() - searchStarted, { scope });
    this.metrics.inc('rag_search_total', { scope });
    const fused = reciprocalRankFusion(
      [
        { channel: 'lexical', items: lexical },
        { channel: 'vector', items: vector },
      ],
      (c) => c.chunkId,
    );
    // one chunk per document, best first; a vector-only hit must be similar enough to count
    const seen = new Set<string>();
    const out: RetrievedChunk[] = [];
    for (const r of fused) {
      const c = r.item;
      if (seen.has(c.documentId)) continue;
      const vectorOnly = !r.channels.includes('lexical');
      if (vectorOnly && (c.similarity ?? 0) < this.minSimilarity) continue;
      seen.add(c.documentId);
      out.push({
        chunkId: c.chunkId,
        documentId: c.documentId,
        title: c.title,
        content: c.content,
        scope: c.scope,
        score: r.score,
        channels: r.channels,
        similarity: c.similarity,
      });
      if (out.length >= limit) break;
    }
    // hit quality: did both channels agree on the best result, only one, or none?
    const quality =
      out.length === 0 ? 'none' : out[0].channels.length === 2 ? 'both' : out[0].channels[0];
    this.metrics.inc('rag_results_total', { scope, quality });
    return out;
  }

  /** The SQL that decides what the caller may see. Null when the scope needs a user and there is none. */
  private visibilityFilter(scope: SearchScope, userId: string | null): Prisma.Sql | null {
    if (scope === 'global') return Prisma.sql`d.scope = 'GLOBAL'::"KnowledgeScope"`;
    if (!userId) return scope === 'notes' ? null : Prisma.sql`d.scope = 'GLOBAL'::"KnowledgeScope"`;
    if (scope === 'notes')
      return Prisma.sql`d.scope = 'USER'::"KnowledgeScope" AND d."userId" = ${userId}`;
    return Prisma.sql`(d.scope = 'GLOBAL'::"KnowledgeScope" OR d."userId" = ${userId})`;
  }

  private async lexicalChannel(q: string, visible: Prisma.Sql): Promise<Candidate[]> {
    const terms = queryTerms(q);
    if (terms.length === 0) return [];
    // OR of the terms; longer terms also match as prefixes so "dividennya" finds "dividen"
    const tsquery = terms.map((t) => (t.length >= 4 ? `${t}:*` : t)).join(' | ');
    const rows = await this.prisma.$queryRaw<Array<Candidate & { rank: number }>>`
      SELECT c.id AS "chunkId", c."documentId", d.title, c.content, d.scope,
             ts_rank_cd(c.search, q) AS rank
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d.id = c."documentId",
           to_tsquery('simple', ${tsquery}) q
      WHERE c.search @@ q AND ${visible}
      ORDER BY rank DESC, c.id ASC
      LIMIT ${CANDIDATES_PER_CHANNEL}`;
    return rows.map(({ rank: _rank, ...c }) => c);
  }

  private async vectorChannel(q: string, visible: Prisma.Sql): Promise<Candidate[]> {
    let vector: number[];
    try {
      // the hashing embedding is lexical, so question words would only add noise to it
      const text = this.embeddings.name === 'hashing' ? queryTerms(q).join(' ') || q : q;
      [vector] = await this.embeddings.embed([text]);
    } catch (e) {
      this.metrics.inc('rag_embedding_failures_total', { stage: 'query' });
      this.logger.debug(`query embedding unavailable, lexical only: ${safeErrorMessage(e)}`);
      return [];
    }
    if (vector.every((x) => x === 0)) return [];
    const literal = toVectorLiteral(vector);
    const rows = await this.prisma.$queryRaw<Array<Candidate & { distance: number }>>`
      SELECT c.id AS "chunkId", c."documentId", d.title, c.content, d.scope,
             (c.embedding <=> ${literal}::vector) AS distance
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeDocument" d ON d.id = c."documentId"
      WHERE c."embeddingModel" = ${this.embeddings.model} AND ${visible}
      ORDER BY c.embedding <=> ${literal}::vector ASC, c.id ASC
      LIMIT ${CANDIDATES_PER_CHANNEL}`;
    return rows.map(({ distance, ...c }) => ({ ...c, similarity: 1 - Number(distance) }));
  }
}

/**
 * Question words and connectives carry no topic ("PER dan PBV itu apa" is about PER and PBV). The 'simple'
 * text-search configuration has no stop list, so they are removed here; when nothing else remains the
 * original words are kept.
 */
const QUERY_STOPWORDS = new Set(
  (
    'apa apakah itu ini yang dan atau di ke dari adalah dengan untuk pada saya aku kamu anda bagaimana gimana ' +
    'berapa kenapa mengapa kapan dimana mana siapa bisa boleh tolong mohon jelaskan jelasin arti artinya maksud ' +
    'maksudnya beda bedanya sih dong ya kah ya nya tentang soal mengenai bila jika kalau ' +
    'the is are what how a an of in to and or does do mean means explain'
  ).split(' '),
);

export function queryTerms(q: string): string[] {
  const all = [...new Set(tokenize(q))].filter((t) => /^[a-z0-9]+$/.test(t)).slice(0, 16);
  // only words carry a topic: a question made of stop words, emoji or bare numbers has nothing to retrieve
  // (it used to fall back to the stop words and surface an arbitrary article)
  const topical = all.filter((t) => !QUERY_STOPWORDS.has(t) && /[a-z]/.test(t));
  return topical.slice(0, 12);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** pgvector's text input format: "[0.1,0.2,...]"; numbers are kept short to bound the statement size. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(6)) : 0)).join(',')}]`;
}
