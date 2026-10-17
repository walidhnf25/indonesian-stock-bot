/** IDX tickers are exactly four letters (e.g. BBCA). Yahoo uses the ".JK" suffix. */
const IDX_TICKER = /^[A-Z]{4}$/;

export function normalizeTicker(input: string): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/\.(JK|IDX)$/, '')
    .replace(/^IDX:/, '');
  return IDX_TICKER.test(cleaned) ? cleaned : null;
}

export function isValidTicker(input: string): boolean {
  return normalizeTicker(input) !== null;
}

export function toYahooSymbol(symbol: string): string {
  return `${symbol}.JK`;
}

export function fromYahooSymbol(yahooSymbol: string): string {
  return yahooSymbol.replace(/\.JK$/i, '').toUpperCase();
}
