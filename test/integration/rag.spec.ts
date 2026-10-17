import { ChatService } from '../../src/chat/chat.service';
import { KNOWLEDGE_CORPUS } from '../../src/knowledge/corpus';
import { RagService } from '../../src/rag/rag.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Knowledge retrieval on real PostgreSQL + pgvector with the deterministic hashing embedding.
 * Covers ingestion idempotency, hybrid retrieval quality on a golden set, strict per-user isolation of
 * notes (enforced before ranking), the note commands, deletion cascade and group refusal.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');

describe('RAG (integration)', () => {
  let t: TestApp;
  let chat: ChatService;
  let rag: RagService;
  let users: UserService;
  const GROUP = -100_130;
  const say = async (telegramId: number, text: string, chatId = telegramId) =>
    plain(
      (
        await chat.handle({
          telegramId,
          chatId,
          chatType: chatId < 0 ? 'supergroup' : 'private',
          username: `u${telegramId}`,
          text,
        })
      ).messages.join('\n'),
    );
  const mkUser = async (telegramId: number) =>
    (await users.upsertFromTelegram({ telegramId, chatId: telegramId })).id;

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    rag = t.app.get(RagService);
    users = t.app.get(UserService);
    await rag.ingestCorpus();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    // deleting users cascades to their notes only; TRUNCATE ... CASCADE would also wipe the global corpus
    await t.prisma.user.deleteMany();
    resetCaches(t);
    t.ai.generated.length = 0;
  });

  describe('ingestion', () => {
    it('loads every corpus article once, chunks it, embeds every chunk, and is idempotent', async () => {
      const docs = await t.prisma.knowledgeDocument.count({ where: { scope: 'GLOBAL' } });
      expect(docs).toBe(KNOWLEDGE_CORPUS.length);
      const chunks = await t.prisma.knowledgeChunk.count();
      expect(chunks).toBeGreaterThanOrEqual(docs);
      expect(await t.prisma.knowledgeChunk.count({ where: { embeddingModel: null } })).toBe(0);
      const again = await rag.ingestCorpus();
      expect(again).toMatchObject({ documents: KNOWLEDGE_CORPUS.length, changed: 0, embedded: 0 });
      expect(await t.prisma.knowledgeDocument.count({ where: { scope: 'GLOBAL' } })).toBe(docs);
    });

    it('removes an article that left the corpus (with its chunks) and never touches user notes', async () => {
      const retired = await t.prisma.knowledgeDocument.create({
        data: {
          scope: 'GLOBAL',
          source: 'corpus',
          externalId: 'artikel-lama-yang-sudah-dihapus',
          title: 'Artikel lama',
          content: 'isi lama',
          contentHash: 'old',
          chunks: { create: [{ ordinal: 0, content: 'Artikel lama. isi lama' }] },
        },
      });
      const user = await t.prisma.user.create({
        data: { telegramId: BigInt(97_001), chatId: BigInt(97_001) },
      });
      const note = await t.prisma.knowledgeDocument.create({
        data: {
          scope: 'USER',
          userId: user.id,
          source: 'note',
          externalId: 'catatan-1',
          title: 'catatan',
          content: 'catatan pribadi',
          contentHash: 'note',
        },
      });
      await rag.ingestCorpus();
      expect(await t.prisma.knowledgeDocument.findUnique({ where: { id: retired.id } })).toBeNull();
      expect(await t.prisma.knowledgeChunk.count({ where: { documentId: retired.id } })).toBe(0);
      expect(
        await t.prisma.knowledgeDocument.findUnique({ where: { id: note.id } }),
      ).not.toBeNull();
      expect(await t.prisma.knowledgeDocument.count({ where: { scope: 'GLOBAL' } })).toBe(
        KNOWLEDGE_CORPUS.length,
      );
      await t.prisma.user.delete({ where: { id: user.id } });
    });

    it('re-chunks a document whose content changed and re-embeds only its chunks', async () => {
      const doc = await t.prisma.knowledgeDocument.findFirstOrThrow({
        where: { externalId: 'lot-dan-satuan' },
      });
      await t.prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { contentHash: 'stale' },
      });
      const result = await rag.ingestCorpus();
      expect(result.changed).toBe(1);
      expect(result.embedded).toBeGreaterThan(0);
      expect(
        await t.prisma.knowledgeChunk.count({
          where: { documentId: doc.id, embeddingModel: null },
        }),
      ).toBe(0);
    });
  });

  describe('retrieval quality (golden set, hit@2)', () => {
    const golden: Array<[string, string]> = [
      ['satu lot itu berapa lembar?', 'lot-dan-satuan'],
      ['jam berapa bursa buka dan tutup?', 'jam-perdagangan'],
      ['apa itu ARA dan ARB?', 'auto-rejection'],
      ['fraksi harga saham 500 berapa?', 'fraksi-harga'],
      ['cum date dan ex date dividen artinya apa', 'dividen'],
      ['apa itu right issue dan dilusi', 'aksi-korporasi'],
      ['bagaimana cara ikut IPO', 'ipo-dan-pencatatan'],
      ['IHSG itu dihitung bagaimana', 'indeks-saham'],
      ['biaya transaksi dan pajak jual saham', 'biaya-transaksi'],
      ['apa itu bid offer dan spread', 'order-book'],
      ['apa arti UMA dan suspensi', 'suspensi-dan-uma'],
      ['PER dan PBV itu apa', 'rasio-fundamental'],
      ['net buy asing artinya apa', 'investor-asing-dan-broker'],
      ['apa bedanya floating dan realized', 'capital-gain-dan-floating'],
      ['risiko likuiditas itu apa', 'risiko-saham'],
      ['bagaimana cara pakai alert di Indonesian Stock Bot', 'bot-fitur'],
      ['data Indonesian Stock Bot tertunda berapa menit', 'bot-batasan'],
      ['apa itu bollinger bands', 'glossary-bollinger'],
    ];

    it('finds the right article in the top 2 for at least 90% of the golden questions', async () => {
      let hits = 0;
      const misses: string[] = [];
      for (const [q, expected] of golden) {
        const res = await rag.search(q, { userId: null, scope: 'global', limit: 2 });
        const ids = await Promise.all(
          res.map((r) =>
            t.prisma.knowledgeDocument
              .findUniqueOrThrow({ where: { id: r.documentId } })
              .then((d) => d.externalId),
          ),
        );
        if (ids.includes(expected)) hits++;
        else misses.push(`${q} -> ${ids.join(',')}`);
      }
      if (misses.length > Math.floor(golden.length * 0.1))
        throw new Error(['misses:', ...misses].join(' | '));
      expect(hits / golden.length).toBeGreaterThanOrEqual(0.9);
    });

    it('both channels contribute: a paraphrase without shared words is still found by the vector channel', async () => {
      const res = await rag.search('ex date dividen', { userId: null, scope: 'global', limit: 3 });
      expect(res[0].channels).toEqual(expect.arrayContaining(['lexical']));
      expect(res.some((r) => r.channels.includes('vector'))).toBe(true);
    });

    it('nonsense yields nothing rather than a random article', async () => {
      expect(await rag.search('qzxv wplk ttrrp', { userId: null, scope: 'global' })).toEqual([]);
    });
  });

  describe('notes and isolation', () => {
    it('a note is stored, listed, searchable by its owner and invisible to everyone else — even on an exact match', async () => {
      const alice = await mkUser(13001);
      const bob = await mkUser(13002);
      await rag.addNote(alice, 'ZZTOP cum date 20 Mei, rahasia alice');
      expect(await rag.listNotes(alice)).toHaveLength(1);
      expect(await rag.listNotes(bob)).toHaveLength(0);

      const own = await rag.search('ZZTOP cum date rahasia alice', { userId: alice, scope: 'all' });
      expect(own.some((r) => r.scope === 'USER')).toBe(true);

      for (const scope of ['all', 'notes'] as const) {
        const other = await rag.search('ZZTOP cum date rahasia alice', { userId: bob, scope });
        expect(other.filter((r) => r.scope === 'USER')).toEqual([]);
      }
      const anon = await rag.search('ZZTOP cum date rahasia alice', { userId: null, scope: 'all' });
      expect(anon.filter((r) => r.scope === 'USER')).toEqual([]);
      expect(await rag.search('ZZTOP', { userId: null, scope: 'notes' })).toEqual([]);
    });

    it("a user cannot delete another user's note by number and the cap is enforced", async () => {
      const alice = await mkUser(13003);
      const bob = await mkUser(13004);
      await rag.addNote(alice, 'catatan alice');
      expect(await rag.deleteNotes(bob, { index: 1 })).toEqual([]);
      expect(await rag.deleteNotes(bob, { all: true })).toEqual([]);
      expect(await rag.listNotes(alice)).toHaveLength(1);

      for (let i = 0; i < 50; i++) await rag.addNote(bob, `catatan ${i}`);
      await expect(rag.addNote(bob, 'satu lagi')).rejects.toMatchObject({ code: 'NOTE_LIMIT' });
    });

    it('notes go away with the user (hapus data saya) and never leak into a group answer', async () => {
      await say(13005, 'catat: QQQQ target cum date, catatan pribadi saya');
      expect(await say(13005, 'catatan saya')).toMatch(/1\. QQQQ/);
      expect(await say(13005, 'cari catatan QQQQ')).toMatch(/QQQQ/);
      // the same question from a group must not surface the note
      expect(await say(13005, 'apa itu QQQQ cum date catatan pribadi', GROUP)).not.toMatch(
        /catatan pribadi saya/,
      );
      expect(await say(13005, 'catatan saya', GROUP)).toMatch(/chat pribadi/);

      await say(13005, 'hapus data saya');
      expect(await say(13005, 'konfirmasi hapus data saya')).toMatch(/catatan: 1/);
      expect(await t.prisma.knowledgeDocument.count({ where: { scope: 'USER' } })).toBe(0);
      expect(await t.prisma.knowledgeDocument.count({ where: { scope: 'GLOBAL' } })).toBe(
        KNOWLEDGE_CORPUS.length,
      );
    });

    it('note commands from chat: add, list, delete by number, delete all, size limit', async () => {
      expect(await say(13006, 'catat: BBCA RUPS 15 Mei')).toMatch(/Catatan #1 disimpan/);
      expect(await say(13006, 'simpan catatan TLKM dividen Juni')).toMatch(/Catatan #2 disimpan/);
      expect(await say(13006, 'catat: x')).toMatch(/Tulis isi catatannya/);
      expect(await say(13006, `catat: ${'a'.repeat(501)}`)).toMatch(/maksimal 500/i);
      expect(await say(13006, 'hapus catatan 1')).toMatch(/1 catatan dihapus/);
      expect(await say(13006, 'catatan saya')).toMatch(/1\. TLKM dividen Juni/);
      expect(await say(13006, 'hapus semua catatan')).toMatch(/1 catatan dihapus/);
      expect(await say(13006, 'catatan saya')).toMatch(/Belum ada catatan/);
      // "catat BBCA ke watchlist" is still a watchlist command
      expect(await say(13006, 'catat BBCA ke watchlist')).not.toMatch(/Catatan #/);
    });
  });

  describe('conceptual questions', () => {
    it('a glossary topic still gets the glossary; another concept gets the corpus; nonsense gets the fallback', async () => {
      expect(await say(13010, 'apa itu RSI?')).toMatch(/RSI adalah indikator momentum/);
      const lot = await say(13010, 'satu lot itu berapa lembar?');
      expect(lot).toMatch(/Satu lot sama dengan 100 lembar/);
      expect(lot).not.toMatch(/Lot, lembar, dan nilai transaksi\. Di Bursa/); // heading shown once, not inside the text
      expect(await say(13010, 'apa itu qzxv wplk?')).toMatch(/belum punya penjelasan/);
    });

    it('a corpus answer never contains the model and always carries the disclaimer', async () => {
      const reply = await say(13011, 'apa itu auto rejection?');
      expect(reply).toMatch(/Auto rejection adalah mekanisme bursa/);
      expect(reply).toMatch(/bukan rekomendasi|bukan saran|disclaimer|risiko/i);
      expect(t.ai.generated).toHaveLength(0);
    });
  });
});
