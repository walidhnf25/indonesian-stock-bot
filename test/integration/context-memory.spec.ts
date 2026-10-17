import { ChatService } from '../../src/chat/chat.service';
import { ConversationService } from '../../src/conversation/conversation.service';
import { PortfolioService } from '../../src/portfolio/portfolio.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, flushBackground, resetCaches, TestApp } from '../setup/test-app';

/**
 * Per-chat context (recall, clear), the default-ticker preference and two-step data deletion,
 * on real PostgreSQL. The fixture provider serves TSTA/TSTB; the AI provider is the deterministic test one.
 */
const plain = (html: string) => html.replace(/<[^>]+>/g, '');

describe('Context, preferences and data deletion (integration)', () => {
  let t: TestApp;
  let chat: ChatService;
  let users: UserService;
  let conversation: ConversationService;
  const GROUP = -100_900;
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
  const userOf = (telegramId: number) =>
    t.prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
    users = t.app.get(UserService);
    conversation = t.app.get(ConversationService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await flushBackground(t);
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE "User","Alert","StockQuoteSnapshot","StockDailyPrice","AIAnalysis" RESTART IDENTITY CASCADE',
    );
    resetCaches(t);
    t.sent.length = 0;
  });

  describe('context recall and clearing', () => {
    it('lists the recent lookups of this chat only, newest first, and never message text', async () => {
      await say(9001, 'harga TSTA');
      await say(9001, 'teknikal TSTB');
      await say(9001, 'harga TSTA', GROUP); // a group lookup must not show up in the private recall
      const reply = await say(9001, 'apa yang tadi saya tanya?');
      expect(reply).toMatch(/Yang saya ingat/);
      const lines = reply.split('\n').filter((l) => l.startsWith('•'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/TSTB \(teknikal\)/);
      expect(lines[1]).toMatch(/TSTA \(harga\)/);
      expect(reply).not.toMatch(/teknikal TSTB/); // the message itself is not stored
      const row = await t.prisma.conversationContext.findFirst({
        where: { chatId: BigInt(9001) },
      });
      expect(JSON.stringify(row?.context)).not.toMatch(/harga TSTA/);
    });

    it('keeps at most 10 lookups per chat', async () => {
      const u = (await users.upsertFromTelegram({ telegramId: 9002, chatId: 9002 })).id;
      for (let i = 0; i < 13; i++) await conversation.remember(u, 9002, ['TSTA'], 'STOCK_QUOTE');
      expect(await conversation.recall(u, 9002)).toHaveLength(10);
    });

    it('"lupakan konteks" erases the chat context, so a follow-up asks for the ticker again', async () => {
      await say(9003, 'harga TSTA');
      expect(await say(9003, 'berapa RSI?')).toMatch(/TSTA/); // follow-up resolved from context
      expect(await say(9003, 'lupakan konteks')).toMatch(/dilupakan/);
      expect(await say(9003, 'apa yang tadi saya tanya?')).toMatch(/Belum ada/);
      expect(await say(9003, 'berapa RSI?')).toMatch(/Saham mana/);
    });

    it('memory commands are refused in a group', async () => {
      for (const text of [
        'apa yang tadi saya tanya?',
        'lupakan konteks',
        'pengaturan saya',
        'hapus data saya',
      ]) {
        expect(await say(9004, text, GROUP)).toMatch(/chat pribadi/);
      }
      expect(await t.prisma.conversationContext.count()).toBe(0);
    });
  });

  describe('default ticker preference', () => {
    it('is set, shown, used only when there is no context, and cleared', async () => {
      expect(await say(9010, 'saham default saya TSTA')).toMatch(/Saham default: TSTA/);
      expect(await say(9010, 'pengaturan saya')).toMatch(/Saham default: TSTA/);
      expect(await userOf(9010)).toMatchObject({ preferences: { defaultSymbol: 'TSTA' } });

      expect(await say(9010, 'berapa RSI?')).toMatch(/TSTA/); // no context yet -> default ticker
      await say(9010, 'harga TSTB');
      expect(await say(9010, 'berapa RSI?')).toMatch(/TSTB/); // context wins over the preference

      expect(await say(9010, 'hapus saham default')).toMatch(/dihapus/);
      expect(await say(9010, 'pengaturan saya')).toMatch(/belum ada/);
      expect(await userOf(9010)).toMatchObject({ preferences: {} });
    });

    it('never completes a state-changing command and is not used in a group', async () => {
      await say(9011, 'saham default saya TSTA');
      expect(await say(9011, 'ingatkan saya kalau di atas 1000')).not.toMatch(/Alert dibuat/);
      expect(await t.prisma.alert.count()).toBe(0);
      expect(await say(9011, 'tambahkan ke watchlist')).not.toMatch(/TSTA/);
      expect(await t.prisma.watchlistItem.count()).toBe(0);
      expect(await say(9011, 'berapa RSI?', GROUP)).toMatch(/Saham mana/);
    });

    it('a malformed preferences column is ignored instead of breaking the chat', async () => {
      await say(9012, 'halo');
      await t.prisma.user.update({
        where: { telegramId: BigInt(9012) },
        data: { preferences: { defaultSymbol: 'drop table', role: 'admin' } },
      });
      expect(await say(9012, 'pengaturan saya')).toMatch(/belum ada/);
      expect(await say(9012, 'berapa RSI?')).toMatch(/Saham mana/);
    });
  });

  describe('data deletion', () => {
    const seed = async (id: number) => {
      await say(id, 'saham default saya TSTA');
      await say(id, 'tambahkan TSTA ke watchlist');
      await say(id, 'ingatkan saya kalau TSTA di atas 9000');
      await say(id, 'beli 1 lot TSTA di 1000');
      await flushBackground(t);
    };

    it('needs an explicit second step, then removes everything about the user in one go', async () => {
      await seed(9020);
      const user = (await userOf(9020))!;
      expect(await t.prisma.watchlistItem.count()).toBe(1);
      expect(await t.prisma.alert.count()).toBe(1);
      expect(
        await t.app
          .get(PortfolioService)
          .view(user.id)
          .then((v) => v.holdings.length),
      ).toBe(1);

      const warn = await say(9020, 'hapus data saya');
      expect(warn).toMatch(/permanen/);
      expect(await userOf(9020)).not.toBeNull(); // nothing deleted yet

      const done = await say(9020, 'konfirmasi hapus data saya');
      expect(done).toMatch(/sudah dihapus/);
      expect(done).toMatch(/watchlist: 1 saham/);
      expect(done).toMatch(/alert: 1/);
      expect(done).toMatch(/transaksi portofolio: 1/);
      expect(await userOf(9020)).toBeNull();
      expect(await t.prisma.watchlistItem.count()).toBe(0);
      expect(await t.prisma.alert.count()).toBe(0);
      expect(await t.prisma.portfolioTransaction.count()).toBe(0);
      expect(await t.prisma.holding.count()).toBe(0);
      expect(await t.prisma.conversationContext.count()).toBe(0);
      expect(await t.prisma.stock.count({ where: { symbol: 'TSTA' } })).toBe(1); // shared market data stays

      // the next message recreates a clean profile
      expect(await say(9020, 'pengaturan saya')).toMatch(/belum ada/);
      expect(await userOf(9020)).toMatchObject({ preferences: {} });
    });

    it('a confirmation without a pending request, or after the window, deletes nothing', async () => {
      await seed(9021);
      expect(await say(9021, 'konfirmasi hapus data saya')).toMatch(/Tidak ada permintaan/);
      expect(await userOf(9021)).not.toBeNull();

      await say(9021, 'hapus data saya');
      const u = (await userOf(9021))!;
      const row = await t.prisma.conversationContext.findUniqueOrThrow({
        where: { userId_chatId: { userId: u.id, chatId: BigInt(9021) } },
      });
      const ctx = row.context as Record<string, unknown>;
      await t.prisma.conversationContext.update({
        where: { id: row.id },
        data: {
          context: { ...ctx, deletionRequestedUntil: new Date(Date.now() - 1000).toISOString() },
        },
      });
      expect(await say(9021, 'konfirmasi hapus data saya')).toMatch(/Tidak ada permintaan/);
      expect(await userOf(9021)).not.toBeNull();
      expect(await t.prisma.alert.count()).toBe(1);
    });

    it('a stock lookup in between cancels the pending request', async () => {
      await seed(9022);
      await say(9022, 'hapus data saya');
      await say(9022, 'harga TSTB');
      expect(await say(9022, 'konfirmasi hapus data saya')).toMatch(/Tidak ada permintaan/);
      expect(await userOf(9022)).not.toBeNull();
    });
  });
});
