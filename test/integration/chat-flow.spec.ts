import { AIService } from '../../src/ai/ai.service';
import { ChatService } from '../../src/chat/chat.service';
import { createTestApp, sleep, TestApp, resetCaches, flushBackground } from '../setup/test-app';

describe('ChatService — full natural-language pipeline (fake provider + fake AI, real PostgreSQL)', () => {
  let t: TestApp;
  let chat: ChatService;
  let n = 0;

  const say = async (text: string, telegramId = 5000 + n) => {
    const r = await chat.handle({ telegramId, chatId: telegramId, username: 'tester', text });
    return { ...r, text: r.messages.join('\n\n') };
  };

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.provider.failWith = null;
    t.ai.available = true;
    t.ai.generated = [];
    await t.app.get(AIService).checkHealth(true); // reset the 30s health cache between tests
    n++;
    resetCaches(t);
  });

  it('/start and /help work as system commands', async () => {
    expect((await say('/start')).text).toMatch(/Selamat datang di <b>AI Indonesian Stock Bot<\/b>/);
    const help = await say('/help');
    expect(help.text).toMatch(/Kamu tidak perlu menghafal command/);
    expect(help.text).toContain('analisis BBCA');
  });

  it('"TSTA" returns a quote with timestamp and source, without calling AI', async () => {
    const r = await say('TSTA');
    expect(r.intent).toBe('STOCK_QUOTE');
    expect(r.text).toContain('TSTA');
    expect(r.text).toContain('FIXTURE A Tbk');
    expect(r.text).toMatch(/Harga/);
    expect(r.text).toMatch(/🕐 Data: \d+ \w+ \d{4}, \d{2}:\d{2} WIB/);
    expect(r.text).toContain('Sumber:');
    expect(t.ai.generated).toHaveLength(0);
  });

  it('"harga tsta" (lower case) works the same way', async () => {
    expect((await say('harga tsta')).intent).toBe('STOCK_QUOTE');
  });

  it('technical question uses deterministic indicators only (no AI)', async () => {
    const r = await say('berapa RSI TSTA?');
    expect(r.intent).toBe('STOCK_TECHNICAL');
    expect(r.text).toMatch(/RSI \(14\): \d/);
    expect(t.ai.generated).toHaveLength(0);

    const full = await say('bagaimana kondisi teknikal TSTA?');
    expect(full.text).toMatch(/Kondisi teknikal: <b>(Bullish|Netral|Bearish)<\/b>/);
    expect(full.text).toMatch(/MA20/);
    expect(full.text).toMatch(/Support:/);
    expect(full.text).toMatch(/Resistance:/);
  });

  it('analysis calls the AI, shows deterministic values, risks and the disclaimer', async () => {
    const r = await say('analisis TSTA');
    expect(r.intent).toBe('STOCK_ANALYSIS');
    expect(t.ai.generated.length).toBeGreaterThan(0);
    expect(r.text).toContain('AI ANALYSIS');
    // the AI section is made of application-written catalogue sentences chosen by the (fake) model
    expect(r.text).toMatch(/Harga terakhir Rp1\.777, naik 2,50%/);
    expect(r.text).toMatch(/bukan rekomendasi investasi/);
    // The AI context handed to the model is structured JSON with calculated values
    expect(t.ai.generated[0].prompt).toContain('"symbol":"TSTA"');
    expect(t.ai.generated[0].prompt).toContain('"rsi14"');
    expect(t.ai.generated[0].prompt).toContain('"claims"');
  });

  it('persists the analysis snapshot and AI output in PostgreSQL', async () => {
    await say('analisis TSTA');
    await flushBackground(t);
    const row = await t.prisma.aIAnalysis.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(row).not.toBeNull();
    expect(row?.provider).toBe('fake-ai');
    expect((row?.inputSnapshot as { symbol: string }).symbol).toBe('TSTA');
    expect((row?.output as { summary: string }).summary).toMatch(/^Harga terakhir Rp1\.777/);
  });

  it('"kenapa TSTA naik?" answers from data and says causes are unknown', async () => {
    const r = await say('kenapa TSTA naik hari ini?');
    expect(r.intent).toBe('STOCK_QUESTION');
    expect(r.text).toMatch(/Penyebab pergerakan \(berita\/fundamental\) tidak tersedia/);
    expect(t.ai.generated.at(-1)?.prompt).toContain('kenapa TSTA naik hari ini?');
  });

  it('degrades gracefully when AI is unavailable: deterministic analysis is still delivered', async () => {
    t.ai.available = false;
    // health cache (30s) may still say "available": the call failure must be handled too
    const r = await say('analisis TSTB');
    expect(r.text).toContain('TSTB');
    expect(r.text).toMatch(/Analisis AI sedang tidak tersedia/);
    expect(r.text).toMatch(/Support:/);
    expect(r.text).not.toMatch(/undefined|Error|stack/i);
  });

  it('answers quote and technical questions even when AI is down', async () => {
    t.ai.available = false;
    expect((await say('TSTB')).text).toContain('TSTB');
    expect((await say('RSI TSTB')).text).toMatch(/RSI/);
  });

  it('comparison builds a table and a non-ranking explanation', async () => {
    const r = await say('bandingkan TSTA TSTB TSTC');
    expect(r.intent).toBe('STOCK_COMPARISON');
    expect(r.text).toContain('<pre>');
    expect(r.text).toMatch(/TSTA\s+TSTB\s+TSTC/);
    expect(r.text).toMatch(/tidak menyatakan saham terbaik\/terburuk/);
    expect(r.text).not.toMatch(/pemenang|winner/i);
  });

  it('comparison still works for the valid symbols when one is unknown', async () => {
    const r = await say('bandingkan TSTA TSTB ZZZZ');
    expect(r.text).toContain('PERBANDINGAN TSTA vs TSTB');
    expect(r.text).toContain('ZZZZ');
  });

  it('asks for clarification instead of guessing', async () => {
    expect((await say('bandingkan TSTA')).text).toMatch(/minimal dua saham/);
    expect((await say('ingatkan saya TSTA')).text).toMatch(/lengkapi alert/i);
  });

  it('invalid tickers get a friendly message with no internals', async () => {
    const r = await say('harga ZZZZ');
    expect(r.text).toMatch(/Ticker <b>ZZZZ<\/b> tidak ditemukan/);
    expect(r.text).not.toMatch(/prisma|postgres|stack|Error:/i);
  });

  it('provider outage with nothing stored yields a friendly error, never a crash', async () => {
    t.provider.failWith = 'ERROR';
    const r = await say('harga NEWX');
    expect(r.text).toMatch(/Data saham sedang tidak dapat diambil/);
  });

  it('provider outage with stored data shows the last known data, clearly marked stale', async () => {
    await say('harga TSTC');
    await flushBackground(t);
    await t.moduleRef.get(ChatService)['stock']['stocks']['background'].flush();
    resetCaches(t);
    t.provider.failWith = 'RATE_LIMITED';
    const r = await say('harga TSTC');
    expect(r.text).toMatch(
      /Data terbaru tidak tersedia\. Menampilkan data terakhir yang tersimpan pada/,
    );
    expect(r.text).toMatch(/data tersimpan/);
  });

  it('follow-up questions reuse the conversation context', async () => {
    const user = 6001;
    await say('analisis TSTA', user);
    const r = await say('bagaimana supportnya?', user);
    expect(r.intent).toBe('STOCK_TECHNICAL');
    expect(r.text).toContain('TSTA');
    expect(r.text).toMatch(/Support:/);
  });

  it('"bandingkan dengan X" compares with the previously discussed stock', async () => {
    const user = 6002;
    await say('TSTA', user);
    await sleep(200);
    const r = await say('bandingkan dengan TSTB', user);
    expect(r.intent).toBe('STOCK_COMPARISON');
    expect(r.text).toContain('TSTA vs TSTB');
  });

  it('a follow-up without any context asks which stock is meant', async () => {
    const r = await say('bagaimana supportnya?', 6003);
    expect(r.text).toMatch(/Saham mana yang kamu maksud/);
  });

  it('watchlist: add, list, remove — all in natural language', async () => {
    const user = 7001;
    expect((await say('tambahkan TSTA ke watchlist', user)).text).toMatch(
      /Ditambahkan ke watchlist: <b>TSTA<\/b>/,
    );
    expect((await say('tambahkan TSTB', user)).text).toMatch(/TSTB/);
    const list = await say('lihat watchlist saya', user);
    expect(list.text).toContain('WATCHLIST');
    expect(list.text).toContain('TSTA');
    expect(list.text).toContain('TSTB');
    expect(list.text).toMatch(/🕐 Data:/);
    expect((await say('hapus TSTA dari watchlist', user)).text).toMatch(
      /Dihapus dari watchlist: <b>TSTA<\/b>/,
    );
    const after = await say('lihat watchlist', user);
    expect(after.text).not.toContain('TSTA');
    expect(after.text).toContain('TSTB');
  });

  it('alerts: create, list and delete in natural language', async () => {
    const user = 7002;
    const created = await say('ingatkan saya kalau TSTA di atas 99.999', user);
    expect(created.intent).toBe('ALERT_CREATE');
    expect(created.text).toMatch(/Alert dibuat/);
    expect(created.text).toContain('Rp99.999');
    expect((await say('lihat alert saya', user)).text).toMatch(/1\. TSTA harga di atas Rp99\.999/);
    expect((await say('hapus alert TSTA', user)).text).toMatch(/Alert dihapus/);
    expect((await say('lihat alert saya', user)).text).toMatch(
      /belum punya alert|Tidak ada alert aktif/,
    );
  });

  it('market status question works without data providers', async () => {
    t.provider.failWith = 'ERROR';
    const r = await say('jam berapa market buka?');
    expect(r.intent).toBe('MARKET_STATUS');
    expect(r.text).toMatch(/Jam perdagangan reguler/);
  });

  it('foreign flow and broker summary say the data is unavailable instead of inventing it', async () => {
    expect((await say('foreign flow TSTA')).text).toMatch(
      /Data foreign flow tidak tersedia dari provider saat ini/,
    );
    expect((await say('broker summary TSTA')).text).toMatch(
      /tidak tersedia dari provider saat ini/,
    );
  });

  it('fundamentals show only available metrics', async () => {
    const r = await say('PER TSTA');
    expect(r.text).toMatch(/PER: 10,00x/);
    expect(r.text).not.toMatch(/Market Cap/);
  });

  it('screening: deterministic criteria over the provider universe, with honest scope note', async () => {
    const up = await say('saham apa yang naik hari ini?');
    expect(up.intent).toBe('STOCK_SCREEN');
    expect(up.text).toContain('HASIL SCREENING');
    expect(up.text).toContain('TSTA');
    expect(up.text).not.toContain('TSTB'); // TSTB is down in the fixture
    expect(up.text).toMatch(/bukan seluruh saham IDX/);

    const vol = await say('saham apa yang volumenya tinggi?');
    expect(vol.text).toContain('TSTA'); // 3x average volume in fixture
    expect(vol.text).not.toContain('TSTB');

    const rsi = await say('saham yang RSI-nya di atas 70');
    expect(rsi.text).toContain('TSTA'); // synthetic uptrend
    expect(rsi.text).toMatch(/Indikator dihitung untuk/);

    const none = await say('saham yang RSI-nya di atas 100');
    expect(none.text).toMatch(/Tidak ada saham yang memenuhi kriteria/);
  });

  it('general questions are answered by the deterministic glossary: no AI call, works with AI down', async () => {
    const before = t.ai.generated.length;
    const ok = await say('apa itu RSI?');
    expect(ok.intent).toBe('GENERAL_QUESTION');
    expect(ok.text).toMatch(/Relative Strength Index/);
    t.ai.available = false;
    await t.app.get(AIService).checkHealth(true);
    expect((await say('jelaskan apa itu MACD')).text).toMatch(
      /Moving Average Convergence Divergence/,
    );
    expect(t.ai.generated.length).toBe(before); // the model was never involved
  });

  it('unknown input gets a helpful hint (AI classifier cannot invent intents)', async () => {
    t.ai.available = false;
    await t.app.get(AIService).checkHealth(true);
    const r = await say('asdf qwerty');
    expect(r.intent).toBe('UNKNOWN');
    expect(r.text).toMatch(/belum mengerti/);
  });

  it('rate limits a single Telegram user without affecting others', async () => {
    const spammer = 8001;
    let limited = '';
    for (let i = 0; i < 25; i++) {
      const r = await say('/help', spammer);
      if (/Terlalu banyak pesan/.test(r.text)) {
        limited = r.text;
        break;
      }
    }
    expect(limited).toMatch(/Coba lagi dalam \d+ detik/);
    expect((await say('/help', 8002)).text).toMatch(/Kamu tidak perlu menghafal/);
  });

  it('limits per-user AI usage and still answers deterministically', async () => {
    const user = 9001;
    let note = '';
    for (let i = 0; i < 12; i++) {
      const r = await say('analisis TSTA', user);
      if (/Batas penggunaan AI per menit tercapai/.test(r.text)) {
        note = r.text;
        break;
      }
      await sleep(50);
    }
    expect(note).toMatch(/Support:/);
  }, 60000);

  it('never emits trade instructions or certainty in any response', async () => {
    const outputs = [
      (await say('analisis TSTA', 9100)).text,
      (await say('kenapa TSTB turun?', 9100)).text,
      (await say('bandingkan TSTA TSTB', 9100)).text,
    ].join('\n');
    expect(outputs).not.toMatch(
      /beli sekarang|jual sekarang|pasti naik|pasti turun|100% cuan|dijamin/i,
    );
    void n;
  });
});
