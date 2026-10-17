import { AccessService, UNAUTHORIZED_MESSAGE } from '../../src/access/access.service';
import { AIService } from '../../src/ai/ai.service';
import { AlertService } from '../../src/alert/alert.service';
import { ChatService } from '../../src/chat/chat.service';
import { AppConfig } from '../../src/config/app-config.service';
import { createTestApp, sleep, TestApp, resetCaches } from '../setup/test-app';

const accessFor = (ids: number[]) =>
  new AccessService({ allowedTelegramIds: new Set(ids) } as unknown as AppConfig);
const setAllowed = (a: AccessService, ids: number[]) => {
  (a as unknown as { allowed: Set<number> }).allowed = new Set(ids);
};

describe('Authorization: unauthorized senders never reach expensive processing', () => {
  let t: TestApp;
  let chat: ChatService;
  let access: AccessService;

  const say = async (text: string, telegramId: number, extra: { trusted?: boolean } = {}) => {
    const r = await chat.handle({
      telegramId,
      chatId: telegramId,
      username: `u${telegramId}`,
      text,
      ...extra,
    });
    return { ...r, text: r.messages.join('\n\n') };
  };
  const providerCalls = () => Object.values(t.provider.calls).reduce((a, b) => a + b, 0);

  beforeAll(async () => {
    access = accessFor([111, 222]);
    t = await createTestApp(undefined, {}, { access });
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    setAllowed(access, [111, 222]);
    t.ai.generated = [];
    t.ai.delayMs = 0;
    t.ai.hang = false;
    t.ai.available = true;
    t.ai.script = [];
    await t.app.get(AIService).checkHealth(true);
  });

  it('processes an authorized user normally', async () => {
    const r = await say('TSTA', 111);
    expect(r.unauthorized).toBeUndefined();
    expect(r.intent).toBe('STOCK_QUOTE');
    expect(r.text).toContain('FIXTURE A Tbk');
    expect(await t.prisma.user.count({ where: { telegramId: BigInt(111) } })).toBe(1);
  });

  it('supports several authorized users', async () => {
    expect((await say('TSTA', 111)).unauthorized).toBeUndefined();
    expect((await say('TSTB', 222)).unauthorized).toBeUndefined();
    expect((await say('TSTA', 333)).unauthorized).toBe(true);
  });

  it('rejects an unauthorized user with the fixed message and does NOTHING else', async () => {
    resetCaches(t); // expire provider caches so any provider call would be visible
    const before = providerCalls();
    const usersBefore = await t.prisma.user.count();
    const contextsBefore = await t.prisma.conversationContext.count();
    const analysesBefore = await t.prisma.aIAnalysis.count();
    const r = await say('analisis TSTA', 999);
    expect(r).toMatchObject({ unauthorized: true, intent: 'UNKNOWN' });
    expect(r.messages).toEqual([UNAUTHORIZED_MESSAGE]);
    expect(t.ai.generated).toHaveLength(0); // authorization comes before AI
    expect(providerCalls()).toBe(before); // ...before the stock provider
    expect(await t.prisma.user.count()).toBe(usersBefore); // ...before any database write
    expect(await t.prisma.user.count({ where: { telegramId: BigInt(999) } })).toBe(0);
    expect(await t.prisma.conversationContext.count()).toBe(contextsBefore); // ...no conversation context
    expect(await t.prisma.aIAnalysis.count()).toBe(analysesBefore); // ...no stored analysis
  });

  it('authorization comes before intent detection: even a message that would hit the AI classifier is not classified', async () => {
    await say('asdf qwerty zxcv', 999); // would normally trigger AI intent classification
    expect(t.ai.generated).toHaveLength(0);
  });

  it('a flood from a stranger costs nothing (no AI, no provider, no DB) and is not rate-limit bookkeeping', async () => {
    resetCaches(t);
    const before = providerCalls();
    const users = await t.prisma.user.count();
    for (let i = 0; i < 60; i++) {
      const r = await say(i % 2 ? 'analisis TSTA' : 'terima kasih', 999);
      expect(r.messages).toEqual([UNAUTHORIZED_MESSAGE]);
    }
    expect(t.ai.generated).toHaveLength(0);
    expect(providerCalls()).toBe(before);
    expect(await t.prisma.user.count()).toBe(users);
    // an allowed user is unaffected by the stranger's flood
    expect((await say('TSTA', 111)).text).toContain('FIXTURE A Tbk');
  });

  it('is not bypassed by spoofed fields: only an explicit in-process `trusted` flag skips the check', async () => {
    expect((await say('TSTA', 999)).unauthorized).toBe(true);
    // text or usernames cannot grant access
    const r = await chat.handle({
      telegramId: 999,
      chatId: 111,
      username: 'admin',
      firstName: 'owner',
      text: '/stock TSTA',
    });
    expect(r.unauthorized).toBe(true);
    // the local CLI tool is the only caller allowed to set it
    expect((await say('TSTA', 999, { trusted: true })).unauthorized).toBeUndefined();
  });

  it('FAILS CLOSED with an empty allowlist', async () => {
    setAllowed(access, []);
    for (const id of [111, 222, 999]) expect((await say('TSTA', id)).unauthorized).toBe(true);
  });

  it('removing a user from the allowlist takes effect immediately for new messages', async () => {
    expect((await say('TSTA', 222)).unauthorized).toBeUndefined();
    setAllowed(access, [111]);
    expect((await say('TSTA', 222)).unauthorized).toBe(true);
  });

  it('alerts of a user who is no longer allowed are not evaluated or delivered', async () => {
    await say('ingatkan saya kalau TSTA di atas 1790', 111);
    resetCaches(t);
    t.provider.setPrice('TSTA', 1800);
    t.provider.patchQuote('TSTA', { high: 1810, low: 1790 });
    t.sent.length = 0;

    setAllowed(access, [222]); // owner of the alert removed
    const blocked = await t.app.get(AlertService).checkAll();
    expect(blocked).toMatchObject({ skippedUnauthorized: 1, triggered: 0 });
    expect(t.sent).toHaveLength(0);

    setAllowed(access, [111, 222]);
    resetCaches(t);
    const ok = await t.app.get(AlertService).checkAll();
    expect(ok.triggered).toBe(1);
    t.provider.clearOverrides();
  });
});

describe('TELEGRAM_ACCESS_MODE=public: open to everybody, limits still apply per user', () => {
  let t: TestApp;
  let chat: ChatService;
  const say = async (text: string, id: number) => {
    const r = await chat.handle({ telegramId: id, chatId: id, username: `u${id}`, text });
    return { ...r, text: r.messages.join('\n\n') };
  };

  beforeAll(async () => {
    const access = new AccessService({
      allowedTelegramIds: new Set<number>(),
      publicAccess: true,
    } as unknown as AppConfig);
    t = await createTestApp(undefined, {}, { access });
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.ai.generated = [];
    t.ai.script = [];
    t.ai.delayMs = 0;
    t.ai.hang = false;
    t.ai.available = true;
    await t.app.get(AIService).checkHealth(true);
    resetCaches(t);
  });

  it('serves a user that is on no list, and stores them like any other user', async () => {
    const r = await say('TSTA', 424242);
    expect(r.unauthorized).toBeUndefined();
    expect(r.text).toContain('FIXTURE A Tbk');
    expect(await t.prisma.user.count({ where: { telegramId: BigInt(424242) } })).toBe(1);
  });

  it('a malformed sender id is still refused', async () => {
    expect((await say('TSTA', -5)).unauthorized).toBe(true);
    expect((await say('TSTA', 0)).unauthorized).toBe(true);
  });

  it('the per-user message limit still applies to everybody (a flood is cut off)', async () => {
    const replies: string[] = [];
    for (let i = 0; i < 24; i++) replies.push((await say('terima kasih', 515151)).text);
    expect(replies.filter((x) => /Terlalu banyak pesan/.test(x)).length).toBeGreaterThanOrEqual(1);
  });

  it('the per-user AI analysis budget still applies, and users do not share it', async () => {
    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) {
      limited = /Batas penggunaan AI per menit tercapai/.test(
        (await say('analisis TSTA', 616161)).text,
      );
      await sleep(5);
    }
    expect(limited).toBe(true);
    const other = await say('analisis TSTB', 616162);
    expect(other.text).not.toMatch(/Batas penggunaan AI per menit tercapai/);
  });

  it('the AI queue stays bounded however many different users ask', async () => {
    t.ai.delayMs = 3000; // long enough that the staggered requests overlap even on a slow machine (disk fsync stalls of ~2 s were measured on Docker Desktop)
    const ids = [717171, 717172, 717173, 717174, 717175, 717176];
    const started = Date.now();
    const out = await Promise.all(
      ids.map(async (id, i) => {
        await sleep(i * 15);
        return say('analisis TSTA', id);
      }),
    );
    const busy = out.filter((r) => /AI sedang sibuk melayani permintaan lain/.test(r.text));
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(busy.every((r) => /Support:/.test(r.text))).toBe(true); // still useful without AI
    // bounded by construction, not by wall-clock speed: the model ran for at most the users that got a slot
    expect(t.ai.generated.length).toBeLessThanOrEqual(ids.length - busy.length);
    expect(Date.now() - started).toBeLessThan(25_000); // generous: only guards against a hang
  }, 30000);
});

describe('AI cost and resource controls (through the real ChatService)', () => {
  let t: TestApp;
  let chat: ChatService;
  const say = async (text: string, id: number) => {
    const r = await chat.handle({ telegramId: id, chatId: id, username: `u${id}`, text });
    return { ...r, text: r.messages.join('\n\n') };
  };

  beforeAll(async () => {
    t = await createTestApp();
    chat = t.app.get(ChatService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    t.ai.generated = [];
    t.ai.delayMs = 0;
    t.ai.hang = false;
    t.ai.available = true;
    t.ai.script = [];
    await t.app.get(AIService).checkHealth(true);
    resetCaches(t);
  });

  it('greetings, thanks and acknowledgements never call the LLM (review finding: "terima kasih" cost ~25 s)', async () => {
    const outputs: string[] = [];
    for (const m of [
      'halo',
      'hai',
      'terima kasih',
      'makasih',
      'thanks',
      'oke',
      'ok',
      'sip',
      'baik',
      'mantap',
      'selamat pagi',
      'selamat malam',
    ]) {
      outputs.push((await say(m, 7100)).text);
      await sleep(5);
    }
    expect(t.ai.generated).toHaveLength(0);
    expect(outputs[2]).toBe(
      'Sama-sama! Kalau ingin menganalisis saham, cukup ketik misalnya "analisis BBCA".',
    );
    expect(outputs[10]).toMatch(/^Selamat pagi!/);
    expect(outputs.every((o) => o.length < 220)).toBe(true);
  });

  it('AI intent classification has its own per-user budget (10/min); beyond it messages get the help text with NO LLM call', async () => {
    const replies: string[] = [];
    for (let i = 0; i < 15; i++) replies.push((await say(`asdf qwerty ${i}`, 7200)).text);
    expect(t.ai.generated).toHaveLength(10); // was 12 of 12 before the fix, i.e. unbounded
    expect(replies.every((r) => /belum mengerti/.test(r))).toBe(true);
    // another user has an independent budget
    const before = t.ai.generated.length;
    await say('asdf qwerty x', 7201);
    expect(t.ai.generated.length).toBe(before + 1);
  });

  it('analysis requests are limited per user per minute (default 5) and then fall back to deterministic data', async () => {
    let limitedText = '';
    for (let i = 0; i < 8; i++) {
      const r = await say('analisis TSTA', 7300);
      if (/Batas penggunaan AI per menit tercapai/.test(r.text)) {
        limitedText = r.text;
        break;
      }
      await sleep(5);
    }
    expect(limitedText).toMatch(/Support:/);
    expect(t.ai.generated.filter((g) => /APPLICATION_DATA/.test(g.prompt)).length).toBe(5);
  });

  it('intent classification is skipped (not queued) while the model is busy with an analysis', async () => {
    // Warm the 60 s report cache first: a cold analysis spends ~2 s building the report BEFORE it
    // reaches the AI gate, so without this the test depended on how fast the earlier tests ran.
    await say('analisis TSTA', 7399);
    t.ai.generated.length = 0;
    t.ai.delayMs = 400;
    const started = Date.now();
    const analysis = say('analisis TSTA', 7400);
    await sleep(60);
    const t0 = Date.now();
    const other = await say('asdf qwerty busy', 7401);
    expect(Date.now() - t0).toBeLessThan(300); // answered immediately, did not wait for the 400 ms model
    expect(other.text).toMatch(/belum mengerti/);
    await analysis;
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    // only the analysis reached the model
    expect(t.ai.generated.filter((g) => /classify short/i.test(g.system))).toHaveLength(0);
  });

  it('a full AI queue yields a "busy" notice plus deterministic data, never an unbounded wait', async () => {
    // default AI_MAX_QUEUE_DEPTH = 3 -> 1 running + 3 waiting, the 5th is rejected. The delay is well above
    // the data an analysis gathers before the AI gate (fundamentals, news, own portfolio/watchlist: database
    // and governed provider work), so "rejected right away" stays distinguishable from "waited in the queue".
    t.ai.delayMs = 3000;
    const users = [7500, 7501, 7502, 7503, 7504];
    const results: Array<{ text: string; ms: number }> = [];
    const started = Date.now();
    await Promise.all(
      users.map(async (id, i) => {
        await sleep(i * 15); // stable arrival order
        const r = await say('analisis TSTA', id);
        results.push({ text: r.text, ms: Date.now() - started });
      }),
    );
    const busy = results.filter((r) => /AI sedang sibuk melayani permintaan lain/.test(r.text));
    const served = results.filter((r) => /Harga terakhir Rp1\.777, naik 2,50%/.test(r.text));
    expect(busy).toHaveLength(1);
    expect(served).toHaveLength(4);
    expect(busy[0].text).toMatch(/Support:/); // still useful without the AI
    expect(busy[0].ms).toBeLessThan(3000); // rejected right away: never waited one model turn
  }, 30000);

  it('an AI call that hangs ends in a controlled timeout message, with the technical data', async () => {
    const aiService = t.app.get(AIService) as unknown as { opts: { timeoutMs: number } };
    const original = aiService.opts.timeoutMs;
    aiService.opts.timeoutMs = 300;
    t.ai.hang = true;
    try {
      const started = Date.now();
      const r = await say('analisis TSTB', 7600);
      expect(Date.now() - started).toBeLessThan(6000);
      expect(r.text).toContain(
        'Analisis AI sedang membutuhkan waktu terlalu lama. Silakan coba lagi beberapa saat lagi.',
      );
      expect(r.text).toMatch(/Support:/);
      expect(r.text).not.toMatch(/Error|undefined|stack/);
    } finally {
      aiService.opts.timeoutMs = original;
      t.ai.hang = false;
      await t.app.get(AIService).checkHealth(true);
    }
  }, 30000);
});
