import { AlertCondition, AlertMetric, AlertParameters } from '../intent.types';
import { NUMBER_TOKEN, parseIdNumber } from './number-parser';

const ABOVE = String.raw`(?:di\s?atas|lebih\s(?:dari|tinggi\sdari|besar\sdari)|melebihi|menembus|tembus|naik\s(?:ke|sampai|hingga|menuju)|mencapai|capai|sampai|>=?|≥)`;
const BELOW = String.raw`(?:di\s?bawah|kurang\sdari|lebih\s(?:rendah|kecil)\sdari|turun\s(?:ke|sampai|hingga|menuju)|menyentuh|jatuh\s(?:ke|di\sbawah)|<=?|≤)`;

const ABOVE_RE = new RegExp(`${ABOVE}\\s*(${NUMBER_TOKEN})`, 'i');
const BELOW_RE = new RegExp(`${BELOW}\\s*(${NUMBER_TOKEN})`, 'i');
const VOLUME_MULTIPLIER_RE = /(\d+(?:[.,]\d+)?)\s*(?:x|kali|×)\b/i;

/** True when the text looks like a request to create an alert. */
export function isAlertRequest(text: string): boolean {
  // "kasih tahu apakah saya harus masuk" is a question; "kasih tahu KALAU BBCA di atas 8500" is an alert.
  // The "tell me" verbs only count together with a conditional word.
  const alertNoun =
    /\b(ingatkan|ingetin|ingatin|alert|notifikasi|notif|pengingat|peringatan|set\s?alarm|alarm)\b/i;
  const tellVerb = /\b(kasih\s?tahu|kasi\s?tau|beri\s?tahu|kabari|kabarin|beritahu)\b/i;
  const conditional = /\b(kalau|kalo|jika|bila|apabila|ketika|saat|begitu|if|when)\b/i;
  return alertNoun.test(text) || (tellVerb.test(text) && conditional.test(text));
}

export interface ParsedAlert extends AlertParameters {
  missing: string[];
}

/** Extracts metric/condition/value for an alert request. Pure & deterministic. */
export function parseAlert(text: string): ParsedAlert {
  const t = text.toLowerCase();

  // Volume multiplier: "volume BBCA lebih dari 2x rata-rata"
  if (/\bvolume\b|\bvol\b/.test(t)) {
    const m = t.match(VOLUME_MULTIPLIER_RE);
    if (m) {
      const value = parseIdNumber(m[1]);
      if (value !== null && value > 0) {
        return { metric: 'volume', condition: 'above', value, missing: [] };
      }
    }
    return { metric: 'volume', missing: ['value'] };
  }

  // MA20/MA50 crossover: "golden cross", "death cross", "MA20 memotong MA50 ke atas", "ma20 cross ma50"
  const golden =
    /\bgolden\s*cross\b|\bma\s*20\s*(?:[a-z]{4}\s+)?(?:memotong|menembus|cross(?:ing)?|lewat|melewati|di\s*atas)\s*ma\s*50\s*(?:ke\s*atas)?\b|\bcross(?:ing)?\s*(?:ke\s*)?atas\b/i;
  const death =
    /\bdeath\s*cross\b|\bma\s*20\s*(?:[a-z]{4}\s+)?(?:memotong|menembus|cross(?:ing)?|lewat|melewati|di\s*bawah)\s*ma\s*50\s*ke\s*bawah\b|\bcross(?:ing)?\s*(?:ke\s*)?bawah\b/i;
  if (death.test(t)) return { metric: 'ma', condition: 'below', value: 0, missing: [] };
  if (golden.test(t)) return { metric: 'ma', condition: 'above', value: 0, missing: [] };

  const metric: AlertMetric = /\brsi\b/.test(t) ? 'rsi' : 'price';
  const above = t.match(ABOVE_RE);
  const below = t.match(BELOW_RE);

  // If both match (e.g. "turun di bawah" also contains "di bawah"), pick the earliest match.
  let condition: AlertCondition | undefined;
  let rawValue: string | undefined;
  if (above && below) {
    const useAbove = (above.index ?? 0) <= (below.index ?? 0);
    condition = useAbove ? 'above' : 'below';
    rawValue = (useAbove ? above : below)[1];
  } else if (above) {
    condition = 'above';
    rawValue = above[1];
  } else if (below) {
    condition = 'below';
    rawValue = below[1];
  }

  const value = rawValue !== undefined ? parseIdNumber(rawValue.trim()) : null;
  const missing: string[] = [];
  if (!condition) missing.push('condition');
  if (value === null || value <= 0) missing.push('value');

  return {
    metric,
    condition,
    value: value !== null && value > 0 ? value : undefined,
    missing,
  };
}

export function alertTypeFor(metric: AlertMetric, condition: AlertCondition) {
  if (metric === 'price') return condition === 'above' ? 'PRICE_ABOVE' : 'PRICE_BELOW';
  if (metric === 'rsi') return condition === 'above' ? 'RSI_ABOVE' : 'RSI_BELOW';
  if (metric === 'ma') return condition === 'above' ? 'MA_CROSS_ABOVE' : 'MA_CROSS_BELOW';
  return 'VOLUME_MULTIPLIER';
}
