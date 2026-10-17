import { AlertService } from '../../src/alert/alert.service';
import { UserService } from '../../src/user/user.service';
import { createTestApp, TestApp, resetCaches } from '../setup/test-app';

/**
 * Alerts must never fire (or be consumed) on data that is stale, has an
 * unusable timestamp, or fails the price sanity check. Validation order in AlertService.checkAll:
 * fetched -> freshness -> plausibility -> evaluate -> claim -> notify.
 */
describe('Alert evaluation safety (real PostgreSQL, fixture provider)', () => {
  let t: TestApp;
  let alerts: AlertService;
  let alice: string;

  const DAY = 86_400_000;
  /** Applies a patch, then waits for the 1 s quote cache to expire so checkAll sees it. */
  const glitch = async (symbol: string, patch: Parameters<typeof t.provider.patchQuote>[1]) => {
    t.provider.patchQuote(symbol, patch);
    resetCaches(t);
  };
  const statusOf = async () => (await t.prisma.alert.findFirst())?.status;

  beforeAll(async () => {
    t = await createTestApp();
    alerts = t.app.get(AlertService);
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE "User","Alert" RESTART IDENTITY CASCADE');
    t.sent.length = 0;
    t.provider.failWith = null;
    t.provider.clearOverrides();
    alice = (
      await t.app
        .get(UserService)
        .upsertFromTelegram({ telegramId: 111, chatId: 111, username: 'alice' })
    ).id;
    resetCaches(t);
  });

  it('CONTROL: a genuine move fires exactly once (the guards do not block real data)', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
    await glitch('TSTA', { price: 1800, high: 1810, low: 1790 });
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 1, skippedAnomaly: 0, skippedStale: 0 });
    expect(t.sent).toHaveLength(1);
  });

  it('CONTROL: a large but real daily move (+12%, whole day traded around it) still fires', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1900);
    const q = await t.provider.getQuote('TSTA');
    if (!q.available) throw new Error('fixture');
    const price = Math.round(q.data.previousClose! * 1.12);
    await glitch('TSTA', {
      price,
      open: price - 20,
      high: price + 20,
      low: price - 40,
      changePercent: 12,
    });
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 1, skippedAnomaly: 0 });
  });

  it('a price-below alert does NOT fire on a glitch price of Rp1 (the original finding)', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'below', 1000);
    await glitch('TSTA', { price: 1 });
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
    expect(t.sent).toHaveLength(0);
    expect(await statusOf()).toBe('ACTIVE'); // not consumed: it can still fire on good data
  });

  it('a jump with an unchanged day range is anomalous (no corroboration from open/high/low)', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 3000);
    await glitch('TSTA', { price: 5200 }); // high/low stay near 1.777
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
    expect(t.sent).toHaveLength(0);
  });

  it('inconsistent OHLC (high below low) is refused', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
    await glitch('TSTA', { price: 1800, high: 1700, low: 1800 });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
  });

  it('a zero or negative price is refused', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'below', 1000);
    await glitch('TSTA', { price: 0 });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
    await glitch('TSTA', { price: -50 });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
    expect(t.sent).toHaveLength(0);
  });

  it('a provider change% that contradicts the price is refused', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
    await glitch('TSTA', { price: 1800, high: 1810, low: 1790, changePercent: 40 });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
  });

  it('an old timestamp (STALE) never fires, even when the condition is met', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1000);
    await glitch('TSTA', { timestamp: new Date(Date.now() - 6 * DAY).toISOString() });
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 0, skippedStale: 1 });
    expect(t.sent).toHaveLength(0);
    expect(await statusOf()).toBe('ACTIVE');
  });

  it('an unparsable timestamp (UNKNOWN) never fires', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1000);
    await glitch('TSTA', { timestamp: 'not-a-date' });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 0, skippedStale: 1 });
    expect(t.sent).toHaveLength(0);
  });

  it('a timestamp in the future (UNKNOWN) never fires', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1000);
    await glitch('TSTA', { timestamp: new Date(Date.now() + DAY).toISOString() });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 0, skippedStale: 1 });
    expect(t.sent).toHaveLength(0);
  });

  it('indicator (RSI) alerts are blocked by an anomalous quote too', async () => {
    await alerts.create(alice, 'TSTA', 'rsi', 'above', 70); // synthetic uptrend: RSI is far above 70
    await glitch('TSTA', { price: 1 });
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 0, skippedAnomaly: 1 });
    expect(t.sent).toHaveLength(0);
  });

  it('indicator (RSI) alerts are blocked by a stale quote too', async () => {
    await alerts.create(alice, 'TSTA', 'rsi', 'above', 70);
    await glitch('TSTA', { timestamp: new Date(Date.now() - 6 * DAY).toISOString() });
    expect(await alerts.checkAll()).toMatchObject({ triggered: 0, skippedStale: 1 });
  });

  it('skipped alerts are not consumed: once the data is good again they fire exactly once', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1790);
    await glitch('TSTA', { price: 1, timestamp: new Date(Date.now() - 6 * DAY).toISOString() });
    expect((await alerts.checkAll()).triggered).toBe(0);

    t.provider.clearOverrides();
    t.provider.setPrice('TSTA', 1800);
    t.provider.patchQuote('TSTA', { high: 1810, low: 1790 });
    resetCaches(t);
    expect((await alerts.checkAll()).triggered).toBe(1);
    resetCaches(t);
    expect((await alerts.checkAll()).triggered).toBe(0);
    expect(t.sent).toHaveLength(1);
  });

  it('a bad symbol does not block alerts on other, healthy symbols in the same run', async () => {
    await alerts.create(alice, 'TSTA', 'price', 'above', 1000); // TSTA will be glitched
    await alerts.create(alice, 'TSTB', 'price', 'below', 1100); // TSTB is healthy and satisfied
    await glitch('TSTA', { price: 1 });
    const r = await alerts.checkAll();
    expect(r).toMatchObject({ triggered: 1, skippedAnomaly: 1 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toContain('TSTB');
  });
});
