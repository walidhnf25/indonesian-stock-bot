import { PortfolioParameters } from '../intent.types';
import { NUMBER_TOKEN, parseIdNumber } from './number-parser';

/**
 * Deterministic parser for portfolio bookkeeping. A transaction is only recognised when the
 * message carries a QUANTITY (lot/lembar) and, for buys and sells, a PRICE: "beli 10 lot BBCA di 9000".
 * A bare "beli BBCA?" is advice-seeking and is left to the advice detector. Questions ("berapa", "?",
 * "apakah") are never transactions. The AI classifier can never produce these intents (they change data).
 */
const SHARES_PER_LOT = 100;
/** A minus sign directly before a number ("-5 lot", "di -1000"). */
const NEGATIVE_RE = /(?:^|[^\w])-\s*\d/;

const QTY_RE = new RegExp(String.raw`(${NUMBER_TOKEN})\s*(lot|lembar|saham|shares?|lbr)\b`, 'i');
const PRICE_RE = new RegExp(
  String.raw`(?:\bdi\b|@|\bharga\b|\bseharga\b|\bat\b|\bdgn\s+harga\b|\bdengan\s+harga\b|\bper\s+lembar\b|\bpada\b)\s*(${NUMBER_TOKEN})`,
  'i',
);
const FEE_RE = new RegExp(String.raw`(?:\bfee\b|\bbiaya\b|\bkomisi\b)\s*(${NUMBER_TOKEN})`, 'i');
const AMOUNT_RE = new RegExp(`(${NUMBER_TOKEN})`, 'i');

const BUY_RE = /\b(beli|membeli|dibeli|buy|bought|ambil|borong|serok|akumulasi|masuk)\b/i;
const SELL_RE = /\b(jual|menjual|dijual|sell|sold|lepas|keluar)\b/i;
const DEPOSIT_RE =
  /\b(setor|deposit|top\s?up|topup|tambah\s+dana|masukkan\s+dana|isi\s+dana|transfer\s+masuk)\b/i;
const WITHDRAW_RE = /\b(tarik|withdraw|narik|ambil\s+dana|tarik\s+dana|transfer\s+keluar)\b/i;
const DIVIDEND_RE = /\b(dividen|deviden|dividend)\b/i;
const QUESTION_RE =
  /\?|\b(berapa|apakah|apa|bagaimana|gimana|kapan|sebaiknya|haruskah|bagus|worth|layak|should|rekomendasi|saran)\b/i;

const VIEW_RE = new RegExp(
  [
    // the portfolio itself
    String.raw`\b(?:portofolio|portfolio|porto|kepemilikan)\b`,
    // "posisi saya", "holding saya", "aset saya"
    String.raw`\b(?:posisi|holding|aset)(?:ku)?(?:\s+(?:saya|ku|gue|aku))?\b`,
    // "untung saya berapa", "berapa cuan saya": a P/L word WITH a possessive, so "100% profit?" is not a view
    String.raw`\b(?:untung|rugi|cuan|profit|loss|p/l|pnl|keuntungan|kerugian|imbal\s+hasil|return)(?:ku|\s+(?:saya|gue|aku))\b`,
    String.raw`\bberapa\s+(?:untung|rugi|cuan|profit|keuntungan|kerugian)(?:ku|\s+(?:saya|gue|aku))\b`,
  ].join('|'),
  'i',
);
const HISTORY_RE =
  /\b(riwayat|history|histori|mutasi|daftar)\s+(transaksi|portofolio|porto|pembelian|penjualan)\b|\btransaksi\s+(?:saya|ku|terakhir)\b/i;
const UNDO_RE =
  /\b(batalkan|batal|undo|hapus|cabut)\s+(transaksi|pembelian|penjualan|catatan)(?:\s+(?:terakhir|tadi|barusan))?\b|\bundo\b/i;

/** "ringkas portofolio saya", "bagaimana portofolio saya?", "analisis porto". */
const SUMMARY_RE =
  /\b(ringkas|ringkasan|rangkum|analisis|analisa|evaluasi|review|bagaimana|gimana|nilai)\b.{0,30}\b(portofolio|portfolio|porto)\b|\b(portofolio|portfolio|porto)\b.{0,30}\b(ringkas|rangkum|analisis|analisa|gimana|bagaimana)\b/i;

export type PortfolioParse =
  | { intent: 'PORTFOLIO_SUMMARY' }
  | { intent: 'PORTFOLIO_VIEW' }
  | { intent: 'PORTFOLIO_HISTORY' }
  | { intent: 'PORTFOLIO_UNDO' }
  | { intent: 'PORTFOLIO_RECORD'; parameters: PortfolioParameters; clarification?: string };

export function parsePortfolio(text: string, symbols: string[]): PortfolioParse | null {
  const t = text.toLowerCase();
  if (UNDO_RE.test(t)) return { intent: 'PORTFOLIO_UNDO' };
  if (HISTORY_RE.test(t)) return { intent: 'PORTFOLIO_HISTORY' };

  const record = parseRecord(t, symbols);
  if (record) return record;

  if (SUMMARY_RE.test(t)) return { intent: 'PORTFOLIO_SUMMARY' };
  if (VIEW_RE.test(t)) return { intent: 'PORTFOLIO_VIEW' };
  return null;
}

function parseRecord(t: string, symbols: string[]): PortfolioParse | null {
  const qty = t.match(QTY_RE);
  const isBuy = BUY_RE.test(t);
  const isSell = SELL_RE.test(t);

  if (qty && (isBuy || isSell) && !QUESTION_RE.test(t)) {
    // "beli -5 lot …" used to be recorded as 5 lots: a signed number is never silently absolutised
    if (NEGATIVE_RE.test(t)) {
      return {
        intent: 'PORTFOLIO_RECORD',
        parameters: { txType: isSell && !isBuy ? 'SELL' : 'BUY' },
        clarification:
          'Jumlah dan harga tidak boleh negatif. Tulis mis. "beli 10 lot BBCA di 9000" atau "jual 5 lot BBCA di 9100".',
      };
    }
    const count = parseIdNumber(qty[1]);
    if (count === null) return null;
    const unit = qty[2].toLowerCase();
    const shares = unit === 'lot' ? count * SHARES_PER_LOT : count;
    const priceMatch = t.replace(qty[0], ' ').match(PRICE_RE);
    const price = priceMatch ? parseIdNumber(priceMatch[1]) : null;
    const feeMatch = t.match(FEE_RE);
    const fees = feeMatch ? parseIdNumber(feeMatch[1]) : undefined;
    const parameters: PortfolioParameters = {
      txType: isSell && !isBuy ? 'SELL' : 'BUY',
      quantity: shares,
      price: price ?? undefined,
      fees: fees ?? undefined,
    };
    const problems: string[] = [];
    if (symbols.length === 0) problems.push('kode saham');
    if (price === null) problems.push('harga per lembar');
    return {
      intent: 'PORTFOLIO_RECORD',
      parameters,
      clarification: problems.length
        ? `Catatan transaksi belum lengkap: sebutkan ${problems.join(' dan ')}, mis. "beli 10 lot BBCA di 9000".`
        : undefined,
    };
  }

  if (DIVIDEND_RE.test(t) && !QUESTION_RE.test(t)) {
    const amount = amountOf(t.replace(/\b(dividen|deviden|dividend)\b/i, ' '));
    if (amount !== null) {
      return {
        intent: 'PORTFOLIO_RECORD',
        parameters: { txType: 'DIVIDEND', amount },
      };
    }
    return null; // "dividen BBCA" without an amount is a question about the stock
  }
  if (DEPOSIT_RE.test(t) && !QUESTION_RE.test(t) && symbols.length === 0) {
    const amount = amountOf(t);
    if (amount === null) return clarify('DEPOSIT', 'jumlahnya, mis. "setor 10 juta"');
    return { intent: 'PORTFOLIO_RECORD', parameters: { txType: 'DEPOSIT', amount } };
  }
  if (WITHDRAW_RE.test(t) && !QUESTION_RE.test(t) && symbols.length === 0) {
    const amount = amountOf(t);
    if (amount === null) return clarify('WITHDRAWAL', 'jumlahnya, mis. "tarik 5 juta"');
    return { intent: 'PORTFOLIO_RECORD', parameters: { txType: 'WITHDRAWAL', amount } };
  }
  return null;
}

function clarify(txType: PortfolioParameters['txType'], hint: string): PortfolioParse {
  return {
    intent: 'PORTFOLIO_RECORD',
    parameters: { txType },
    clarification: `Sebutkan ${hint}.`,
  };
}

function amountOf(t: string): number | null {
  const m = t.match(AMOUNT_RE);
  if (!m) return null;
  const v = parseIdNumber(m[1]);
  return v !== null && v > 0 ? v : null;
}
