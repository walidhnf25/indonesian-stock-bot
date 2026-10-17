/**
 * TEST FIXTURES ONLY.
 * Everything here is synthetic and exists to test code paths. None of it is market data and it
 * must never be shown to users as such. Excluded from the production build.
 */
import { AIGenerateRequest, AIProvider } from '../ai/providers/ai-provider.interface';
import { jakartaParts } from '../common/utils/format';
import { ProviderResult, StockDataProvider } from '../stock/stock-data-provider.interface';
import { NewsProvider } from '../news/news-provider.interface';
import { RawNewsItem } from '../news/news.types';
import {
  BrokerSummary,
  CompanyProfile,
  DailyCandle,
  ForeignFlow,
  Fundamentals,
  NormalizedQuote,
  StockSearchResult,
  unavailable,
} from '../stock/stock.types';

export const FIXTURE_PROVIDER_NAME = 'test-fixture';

/** Deterministic synthetic candles ending "today". shape: 'up' | 'down' | 'flat' | 'wave' */
export function syntheticCandles(
  n = 260,
  shape: 'up' | 'down' | 'flat' | 'wave' = 'wave',
  base = 1000,
  lastVolume = 1_000_000,
): DailyCandle[] {
  const out: DailyCandle[] = [];
  const end = Date.now();
  for (let i = 0; i < n; i++) {
    const t = i - (n - 1);
    let close: number;
    switch (shape) {
      case 'up':
        close = base + i * 3;
        break;
      case 'down':
        close = base + n * 3 - i * 3;
        break;
      case 'flat':
        close = base;
        break;
      default:
        close = base + i * 1.5 + Math.sin(i / 6) * 40;
    }
    close = Math.round(close);
    // dated in the exchange calendar (Asia/Jakarta): the app treats candle dates as IDX session dates, so a
    // UTC date would be one day off between 00:00 and 07:00 WIB and make the last candle look like yesterday
    const date = jakartaParts(new Date(end + t * 86_400_000)).isoDate;
    out.push({
      date,
      open: close,
      high: close + 10,
      low: close - 10,
      close,
      volume: i === n - 1 ? lastVolume : 1_000_000 + (i % 7) * 50_000,
    });
  }
  return out;
}

/**
 * Synthetic WEEKDAY-only candles between two fixed ISO dates (inclusive), so tests about specific
 * calendar dates (weekends/holidays have no candle) do not depend on when they run.
 */
export function weekdayCandles(startIso: string, endIso: string, base = 1000): DailyCandle[] {
  const out: DailyCandle[] = [];
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  let i = 0;
  for (let t = new Date(`${startIso}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const close = Math.round(base + i * 2 + Math.sin(i / 7) * 30);
    out.push({
      date: d.toISOString().slice(0, 10),
      open: close - 5,
      high: close + 15,
      low: close - 15,
      close,
      volume: 1_000_000 + (i % 5) * 20_000,
    });
    i++;
  }
  return out;
}

export interface FixtureStock {
  symbol: string;
  name: string;
  candles: DailyCandle[];
  price?: number;
  changePercent?: number;
  volume?: number;
  averageVolume?: number;
  /** Per-stock fundamentals override (merged over the fixture default). */
  fundamentals?: Partial<Fundamentals>;
}

export function fixtureQuote(s: FixtureStock): NormalizedQuote {
  const price = s.price ?? s.candles[s.candles.length - 1].close;
  const prev = s.candles[s.candles.length - 2]?.close ?? price;
  const changePercent = s.changePercent ?? ((price - prev) / prev) * 100;
  return {
    symbol: s.symbol,
    name: s.name,
    price,
    change: price - prev,
    changePercent,
    open: price,
    high: price + 10,
    low: price - 10,
    previousClose: prev,
    volume: s.volume ?? 1_000_000,
    averageVolume: s.averageVolume ?? 1_000_000,
    timestamp: new Date().toISOString(),
    currency: 'IDR',
    marketState: 'REGULAR',
    delayMinutes: null,
    fiftyTwoWeekHigh: price + 200,
    fiftyTwoWeekLow: price - 200,
  };
}

export class FakeStockProvider implements StockDataProvider {
  readonly name = FIXTURE_PROVIDER_NAME;
  stocks = new Map<string, FixtureStock>();
  /** When set, every data call fails with this code. */
  failWith: 'ERROR' | 'RATE_LIMITED' | null = null;
  /** Simulates a provider that answers quotes but has no fundamentals service. */
  fundamentalsUnavailable = false;
  /** Artificial latency per quote call (simulates a slow upstream). */
  delayMs = 0;
  calls = { quote: 0, quotes: 0, history: 0, fundamentals: 0 };
  priceOverride = new Map<string, number>();
  /** Arbitrary field overrides (e.g. an old timestamp or a glitchy open/high/low). */
  private patches = new Map<string, Partial<NormalizedQuote>>();

  constructor(stocks: FixtureStock[] = []) {
    stocks.forEach((s) => this.stocks.set(s.symbol, s));
  }

  setPrice(symbol: string, price: number): void {
    this.priceOverride.set(symbol, price);
  }

  patchQuote(symbol: string, patch: Partial<NormalizedQuote>): void {
    this.patches.set(symbol, { ...(this.patches.get(symbol) ?? {}), ...patch });
  }

  clearOverrides(): void {
    this.priceOverride.clear();
    this.patches.clear();
  }

  private quoteOf(symbol: string): NormalizedQuote | null {
    const s = this.stocks.get(symbol);
    if (!s) return null;
    const q = fixtureQuote(s);
    const o = this.priceOverride.get(symbol);
    if (o !== undefined) q.price = o;
    return { ...q, ...(this.patches.get(symbol) ?? {}) };
  }

  async getQuote(symbol: string): Promise<ProviderResult<NormalizedQuote>> {
    this.calls.quote++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) return unavailable('fixture failure', this.failWith);
    const q = this.quoteOf(symbol);
    return Promise.resolve(
      q ? { available: true, data: q } : unavailable('not found', 'NOT_FOUND'),
    );
  }

  getQuotes(symbols: string[]): Promise<Map<string, NormalizedQuote>> {
    this.calls.quotes++;
    const out = new Map<string, NormalizedQuote>();
    if (this.failWith) return Promise.resolve(out);
    for (const s of symbols) {
      const q = this.quoteOf(s);
      if (q) out.set(s, q);
    }
    return Promise.resolve(out);
  }

  getHistoricalPrices(symbol: string): Promise<ProviderResult<DailyCandle[]>> {
    this.calls.history++;
    if (this.failWith) return Promise.resolve(unavailable('fixture failure', this.failWith));
    const s = this.stocks.get(symbol);
    return Promise.resolve(
      s ? { available: true, data: s.candles } : unavailable('not found', 'NOT_FOUND'),
    );
  }

  getCompanyProfile(symbol: string): Promise<ProviderResult<CompanyProfile>> {
    const s = this.stocks.get(symbol);
    return Promise.resolve(
      s
        ? {
            available: true,
            data: {
              symbol,
              name: s.name,
              sector: null,
              industry: null,
              website: null,
              summary: null,
            },
          }
        : unavailable('not found', 'NOT_FOUND'),
    );
  }

  getFundamentals(symbol: string): Promise<ProviderResult<Fundamentals>> {
    this.calls.fundamentals++;
    const stock = this.stocks.get(symbol);
    if (!stock) return Promise.resolve(unavailable('not found', 'NOT_FOUND'));
    if (this.failWith || this.fundamentalsUnavailable) {
      return Promise.resolve(unavailable('fixture failure', this.failWith ?? 'ERROR'));
    }
    const base: Fundamentals = {
      marketCap: null,
      per: 10,
      pbv: 2,
      roe: 15,
      eps: null,
      dividendYield: null,
      revenue: null,
      netIncome: null,
    };
    // an override replaces the default entirely for the keys it names (null = "provider has none")
    const data: Fundamentals = stock.fundamentals
      ? { ...base, per: null, pbv: null, roe: null, ...stock.fundamentals }
      : base;
    return Promise.resolve({ available: true, data });
  }

  getForeignFlow(): Promise<ProviderResult<ForeignFlow>> {
    return Promise.resolve(
      unavailable('Data foreign flow tidak tersedia dari provider saat ini.', 'UNSUPPORTED'),
    );
  }

  getBrokerSummary(): Promise<ProviderResult<BrokerSummary>> {
    return Promise.resolve(
      unavailable('Data broker summary tidak tersedia dari provider saat ini.', 'UNSUPPORTED'),
    );
  }

  searchStocks(): Promise<ProviderResult<StockSearchResult[]>> {
    return Promise.resolve({ available: true, data: [] });
  }

  getIndexQuote(): Promise<ProviderResult<NormalizedQuote>> {
    return Promise.resolve({
      available: true,
      data: {
        ...fixtureQuote({
          symbol: 'IHSG',
          name: 'FIXTURE INDEX',
          candles: syntheticCandles(5, 'flat', 7000),
        }),
      },
    });
  }

  healthCheck() {
    return Promise.resolve(this.failWith ? { ok: false, detail: 'fixture failure' } : { ok: true });
  }
}

export class FakeAIProvider implements AIProvider {
  readonly name = 'fake-ai';
  readonly model = 'fake-model';
  available = true;
  generated: AIGenerateRequest[] = [];
  /** Scripted raw outputs consumed in order (one per generate call); then the defaults below. */
  script: Array<string | (() => string | Promise<string>)> = [];
  /** Artificial latency per call. */
  delayMs = 0;
  /** When true the call never completes (simulates a stuck model). */
  hang = false;

  async generate(req: AIGenerateRequest): Promise<string> {
    this.generated.push(req);
    if (this.hang) return new Promise<string>(() => undefined);
    if (!this.available) throw new Error('fake AI unavailable');
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.script.shift();
    if (next !== undefined) return typeof next === 'function' ? next() : next;
    return this.defaultResponse(req);
  }

  private defaultResponse(req: AIGenerateRequest): string {
    if (/classify short Indonesian messages/i.test(req.system)) {
      return JSON.stringify({ intent: 'UNKNOWN', symbols: [], parameters: {} });
    }
    if (!req.json) {
      return 'RSI adalah indikator momentum yang membandingkan kenaikan dan penurunan harga untuk menilai kondisi jenuh beli atau jenuh jual.';
    }
    // Like a well-behaved model: pick ids from the claims catalogue in the prompt.
    const ids = (prefix: string): string[] =>
      [...req.prompt.matchAll(new RegExp(`"id":"(${prefix}\\d+)"`, 'g'))].map((m) => m[1]);
    if (ids('D').length > 0) {
      return JSON.stringify({
        differences: ids('D').slice(0, 3),
        considerations: ids('C').slice(0, 1),
      });
    }
    return JSON.stringify({
      observations: ids('O').slice(0, 3),
      risks: ids('R').slice(0, 1),
    });
  }

  checkHealth() {
    return Promise.resolve(
      this.available
        ? { available: true, detail: 'fixture ok' }
        : { available: false, detail: 'fixture down' },
    );
  }
}

export const DEFAULT_FIXTURE_STOCKS: FixtureStock[] = [
  {
    symbol: 'TSTA',
    name: 'FIXTURE A Tbk',
    candles: syntheticCandles(260, 'up', 1000),
    changePercent: 2.5,
    volume: 3_000_000,
    averageVolume: 1_000_000,
  },
  {
    symbol: 'TSTB',
    name: 'FIXTURE B Tbk',
    candles: syntheticCandles(260, 'down', 1000),
    changePercent: -1.5,
    volume: 500_000,
    averageVolume: 1_000_000,
  },
  {
    symbol: 'TSTC',
    name: 'FIXTURE C Tbk',
    candles: syntheticCandles(260, 'wave', 2000),
    changePercent: 0.4,
  },
  { symbol: 'NEWX', name: 'FIXTURE NEW Tbk', candles: syntheticCandles(10, 'up', 500) },
  // Fixed calendar (weekdays 2026-01-01..2026-10-02) for historical-date tests.
  {
    symbol: 'HIST',
    name: 'FIXTURE HIST Tbk',
    candles: weekdayCandles('2026-01-01', '2026-10-02', 1500),
  },
];

/** Scripted headlines per symbol; counts calls so tests can prove the existence gate. */
export class FakeNewsProvider implements NewsProvider {
  readonly name = FIXTURE_PROVIDER_NAME;
  items = new Map<string, RawNewsItem[]>();
  failWith: 'ERROR' | 'RATE_LIMITED' | null = null;
  calls = 0;

  reset(): void {
    this.items.clear();
    this.failWith = null;
    this.calls = 0;
  }

  getNews(symbol: string, limit: number): Promise<ProviderResult<RawNewsItem[]>> {
    this.calls++;
    if (this.failWith) return Promise.resolve(unavailable('fixture failure', this.failWith));
    return Promise.resolve({
      available: true,
      data: (this.items.get(symbol) ?? []).slice(0, limit),
    });
  }
}
