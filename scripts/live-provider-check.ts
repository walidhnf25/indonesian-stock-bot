/**
 * LIVE contract check against the real Yahoo Finance endpoint (needs internet):
 *   npm run test:live
 * Runs in plain Node (not Jest): yahoo-finance2's cookie/crumb handshake does not work inside
 * Jest's VM sandbox. Exit code is non-zero if any check fails.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { YahooProvider } from '../src/stock/providers/yahoo.provider';

const provider = new YahooProvider();
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split('\n')[0]}`);
  }
}

async function main(): Promise<void> {
  console.log('YahooProvider LIVE checks');

  await check('quote: normalized quote for a real IDX ticker', async () => {
    const r = await provider.getQuote('BBCA');
    assert.equal(r.available, true);
    if (!r.available) return;
    assert.equal(r.data.symbol, 'BBCA');
    assert.ok(r.data.price > 0);
    assert.equal(r.data.currency, 'IDR');
    assert.ok(!Number.isNaN(Date.parse(r.data.timestamp)));
  });

  await check('history: ~1y of validated, ascending daily candles', async () => {
    const r = await provider.getHistoricalPrices('BBCA', { range: '1y' });
    assert.equal(r.available, true);
    if (!r.available) return;
    assert.ok(r.data.length > 150, `only ${r.data.length} candles`);
    for (let i = 1; i < r.data.length; i++) assert.ok(r.data[i].date > r.data[i - 1].date);
    assert.ok(r.data.every((c) => c.high >= c.low && c.close > 0));
  });

  await check('quote: NOT_FOUND for a ticker that does not exist', async () => {
    const r = await provider.getQuote('ZZZZ');
    assert.equal(r.available, false);
    if (!r.available) assert.equal(r.code, 'NOT_FOUND');
  });

  await check('batch quotes + composite index (IHSG)', async () => {
    const m = await provider.getQuotes(['BBCA', 'BBRI', 'BMRI']);
    assert.deepEqual([...m.keys()].sort(), ['BBCA', 'BBRI', 'BMRI']);
    const idx = await provider.getIndexQuote();
    assert.equal(idx.available, true);
  });

  await check('fundamentals: only fields the provider returned', async () => {
    const r = await provider.getFundamentals('BBCA');
    assert.equal(r.available, true);
    if (r.available) assert.ok(r.data.per === null || r.data.per > 0);
  });

  await check('does not fabricate foreign flow / broker data', async () => {
    const f = await provider.getForeignFlow();
    const b = await provider.getBrokerSummary();
    assert.ok(!f.available && f.code === 'UNSUPPORTED');
    assert.ok(!b.available && b.code === 'UNSUPPORTED');
  });

  console.log(failed === 0 ? '\nAll live checks passed.' : `\n${failed} live check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
