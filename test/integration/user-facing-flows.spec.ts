import { AIService } from '../../src/ai/ai.service';
import { ChatService } from '../../src/chat/chat.service';
import { createTestApp, TestApp, resetCaches } from '../setup/test-app';

/**
 * User-facing behaviour: historical dates, advice requests, several tickers, freshness labels, implausible
 * quotes and vague screening. Calendar-dependent cases use fixed dates inside the HIST fixture
 * (weekdays 2026-01-01..2026-10-02), so they do not depend on the day the suite runs.
 */
describe('User-facing flows (through the real ChatService)', () => {
  let t: TestApp;
  let chat: ChatService;
  let uid = 9000;
  const say = async (text: string, id = ++uid) => {
    const r = await chat.handle({ telegramId: id, chatId: id, username: `u${id}`, text });
    return { ...r, text: r.messages.join('\n\n') };
  };
  const providerCalls = () => Object.values(t.provider.calls).reduce((a, b) => a + b, 0);

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.ai.generated = [];
    t.ai.script = [];
    t.ai.delayMs = 0;
    t.ai.hang = false;
    t.ai.available = true;
    t.provider.clearOverrides();
    await t.app.get(AIService).checkHealth(true);
  });

  describe("historical dates are never answered with today's data", () => {
    it("an explicit past weekday returns THAT day's candle with the date stated", async () => {
      const r = await say('harga HIST tanggal 15 Juni 2026');
      expect(r.intent).toBe('STOCK_HISTORICAL');
      expect(r.text).toContain('Tanggal diminta: Tanggal (15 Juni 2026)');
      expect(r.text).toContain('Penutupan:');
      expect(r.text).toContain('Data historis harian (end-of-day)');
      expect(r.text).not.toMatch(/LIVE|DELAYED|tertunda/);
      expect(t.ai.generated).toHaveLength(0);
    });

    it('the figure shown is the close stored for that date, not the latest price', async () => {
      const history = await t.provider.getHistoricalPrices('HIST');
      if (!history.available) throw new Error('fixture');
      const day = history.data.find((c) => c.date === '2026-06-15')!;
      const latest = history.data[history.data.length - 1];
      expect(day.close).not.toBe(latest.close); // otherwise this test could pass vacuously
      const fmt = (n: number) => `Rp${n.toLocaleString('id-ID')}`;
      const r = await say('harga HIST tanggal 15 Juni 2026');
      expect(r.text).toContain(fmt(day.close));
      expect(r.text).not.toContain(`Penutupan: <b>${fmt(latest.close)}</b>`);
    });

    it('a weekend date says there was no trading and labels the earlier session', async () => {
      const r = await say('harga HIST tanggal 13 Juni 2026'); // a Saturday
      expect(r.text).toContain('Tidak ada data perdagangan pada 13 Juni 2026');
      expect(r.text).toContain(
        'Data perdagangan terakhir sebelum tanggal itu: <b>12 Juni 2026</b>',
      );
    });

    it('a date older than the provider history says "not available" instead of guessing', async () => {
      const r = await say('harga HIST tanggal 5 Januari 2012');
      expect(r.text).toMatch(/tidak tersedia: riwayat dari provider dimulai/);
      expect(r.text).not.toContain('Penutupan:');
    });

    it('"kemarin" and "minggu lalu" are answered as history, with the requested label', async () => {
      const y = await say('harga TSTA kemarin');
      expect(y.intent).toBe('STOCK_HISTORICAL');
      expect(y.text).toContain('Tanggal diminta: Kemarin');
      const w = await say('harga TSTA minggu lalu');
      expect(w.intent).toBe('STOCK_HISTORICAL');
      expect(w.text).toContain('Tanggal diminta: 1 minggu lalu');
      expect(w.text).toMatch(/Dibanding penutupan terakhir/);
    });

    it('"besok" is a prediction request: fixed refusal, current data explicitly labelled as such, no AI', async () => {
      const r = await say('harga TSTA besok');
      expect(r.intent).toBe('STOCK_ADVICE');
      expect(r.text).toMatch(/Saya tidak memprediksi pergerakan harga di masa depan/);
      expect(r.text).toMatch(/kondisi teknikal terkini sebagai gambaran saja/);
      expect(r.text).not.toMatch(/Penutupan:|Tanggal diminta/); // never presented as tomorrow's or a past close
      expect(t.ai.generated).toHaveLength(0);
    });

    it('an impossible date is rejected, not coerced into another one', async () => {
      const r = await say('harga HIST tanggal 31 Februari 2026');
      expect(r.text).not.toContain('Penutupan:');
      expect(r.text).toMatch(/tanggal/i);
    });
  });

  describe('advice, target price, prediction and guarantee requests never reach the model', () => {
    it.each([
      ['apakah TSTA layak dibeli?', 'trade'],
      ['sebaiknya jual TSTA sekarang?', 'trade'],
      ['berapa target harga TSTA?', 'target_price'],
      ['TSTA akan naik besok?', 'prediction'],
      ['apakah TSTA pasti naik?', 'guarantee'],
    ])('%s -> fixed policy answer + neutral technical data, zero AI calls', async (text, kind) => {
      const r = await say(text);
      expect(r.intent).toBe('STOCK_ADVICE');
      expect(t.ai.generated).toHaveLength(0);
      expect(r.text).toMatch(/Support:/);
      const policy: Record<string, RegExp> = {
        trade: /tidak memberikan instruksi beli\/jual/,
        target_price: /tidak menetapkan target harga masa depan/,
        prediction: /tidak memprediksi/,
        guarantee: /Tidak ada jaminan/,
      };
      expect(r.text).toMatch(policy[kind]);
      expect(r.text).not.toMatch(/pasti naik|beli sekarang|jual sekarang|strong buy/i);
    });
  });

  describe('several tickers are never silently ignored', () => {
    it('analyses every requested ticker (2 -> 2 reports, both named)', async () => {
      const r = await say('analisis TSTA dan TSTB');
      expect(r.messages.length).toBeGreaterThanOrEqual(1);
      expect(r.text).toContain('FIXTURE A Tbk');
      expect(r.text).toContain('FIXTURE B Tbk');
      expect(t.ai.generated.filter((g) => /APPLICATION_DATA/.test(g.prompt)).length).toBe(2);
    });

    it('quotes every requested ticker', async () => {
      const r = await say('harga TSTA TSTB TSTC');
      for (const n of ['FIXTURE A Tbk', 'FIXTURE B Tbk', 'FIXTURE C Tbk'])
        expect(r.text).toContain(n);
    });

    it('more than MAX_SYMBOLS_PER_REQUEST (5) is refused up front with the exact limit message and no data calls', async () => {
      resetCaches(t);
      const before = providerCalls();
      const r = await say('analisis TSTA TSTB TSTC NEWX HIST TSTD');
      expect(r.text).toBe(
        'Maksimal 5 saham per permintaan. Silakan pilih saham yang ingin dianalisis.',
      );
      expect(providerCalls()).toBe(before);
      expect(t.ai.generated).toHaveLength(0);
    });

    it('exactly 5 tickers is allowed', async () => {
      const r = await say('harga TSTA TSTB TSTC NEWX HIST');
      expect(r.text).not.toContain('Maksimal 5 saham');
      expect(r.text).toContain('FIXTURE HIST Tbk');
    });

    it('single-symbol-only features say so instead of picking the first ticker', async () => {
      const r = await say('ingatkan saya kalau TSTA dan TSTB di atas 5000');
      expect(r.text).toMatch(/satu saham/i);
      const alerts = await t.prisma.alert.count();
      expect(alerts).toBe(0);
    });
  });

  describe('freshness is always labelled', () => {
    it('a current fixture quote is LIVE or DELAYED, with a data timestamp line', async () => {
      const r = await say('harga TSTA');
      expect(r.text).toMatch(/🟢 LIVE|🟡 DELAYED/);
      expect(r.text).toContain('🕐 Data: ');
    });

    it('an old quote is shown as STALE with "Data terakhir tersedia", never as current', async () => {
      t.provider.patchQuote('TSTB', {
        timestamp: new Date(Date.now() - 6 * 86_400_000).toISOString(),
      });
      resetCaches(t);
      const r = await say('harga TSTB');
      expect(r.text).toContain('🔴 STALE');
      expect(r.text).toContain('🕐 Data terakhir tersedia:');
      expect(r.text).not.toContain('🕐 Data: ');
    });

    it('the watchlist marks stale entries', async () => {
      const id = ++uid;
      await say('tambah TSTC ke watchlist', id);
      await say('tambah TSTA ke watchlist', id);
      t.provider.patchQuote('TSTC', {
        timestamp: new Date(Date.now() - 6 * 86_400_000).toISOString(),
      });
      resetCaches(t);
      const r = await say('lihat watchlist saya', id);
      expect(r.text).toMatch(/<b>TSTC<\/b>\n[^\n]*⚠️ STALE/);
      expect(r.text).not.toMatch(/<b>TSTA<\/b>\n[^\n]*⚠️ STALE/);
    });
  });

  describe('an implausible quote is flagged to the reader', () => {
    it('a glitched OHLC / extreme jump is shown with a warning', async () => {
      t.provider.patchQuote('TSTA', { price: 1, open: 1777, high: 1787, low: 1767 });
      resetCaches(t);
      const r = await say('harga TSTA');
      expect(r.text).toMatch(/Harga terlihat tidak wajar/);
    });
  });

  describe('vague screening', () => {
    it('"saham apa yang bagus?" explains the available dimensions and does NOT rank stocks', async () => {
      resetCaches(t);
      const before = providerCalls();
      const r = await say('saham apa yang bagus?');
      expect(r.intent).toBe('STOCK_SCREEN');
      expect(r.text).toMatch(/perubahan harga, RSI, volume ratio, MA/);
      expect(r.text).toMatch(/tidak menyusun peringkat/);
      expect(r.text).not.toContain('HASIL SCREENING');
      expect(providerCalls()).toBe(before);
      expect(t.ai.generated).toHaveLength(0);
    });

    it('combined, measurable criteria still run a real screen', async () => {
      const r = await say('saham dengan RSI di bawah 70 dan volume di atas 2x rata-rata');
      expect(r.intent).toBe('STOCK_SCREEN');
      expect(r.text).toContain('HASIL SCREENING');
    });
  });
});
