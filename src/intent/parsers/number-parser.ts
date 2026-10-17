/**
 * Parses Indonesian-style numbers found in chat:
 *   "8500" "8.500" "8,500" "8.500,5" "8,5rb" "8rb" "8 ribu" "8k" "70,5" "2x"
 * Returns null when no number can be read.
 */
export function parseIdNumber(raw: string): number | null {
  const m = raw
    .trim()
    .toLowerCase()
    .match(/^(?:rp\.?\s*)?(\d[\d.,]*)\s*(rb|ribu|k|jt|juta)?$/);
  if (!m) return null;
  const body = m[1].replace(/[.,]+$/, '');
  const suffix = m[2];

  let value: number;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(body)) {
    // 8.500  /  1.250.000  /  8.500,5   (dot = thousands, comma = decimal)
    value = Number(body.replace(/\./g, '').replace(',', '.'));
  } else if (/^\d{1,3}(,\d{3})+$/.test(body)) {
    // 8,500 (comma used as a thousands separator, English style)
    value = Number(body.replace(/,/g, ''));
  } else if (/^\d+,\d+$/.test(body)) {
    value = Number(body.replace(',', '.')); // 70,5
  } else if (/^\d+(\.\d+)?$/.test(body)) {
    value = Number(body);
  } else {
    return null;
  }
  if (!Number.isFinite(value)) return null;
  if (suffix === 'rb' || suffix === 'ribu' || suffix === 'k') value *= 1_000;
  if (suffix === 'jt' || suffix === 'juta') value *= 1_000_000;
  return value;
}

/** Finds the first number-like token (with optional unit suffix) in a string. */
export const NUMBER_TOKEN = String.raw`(?:rp\.?\s*)?\d[\d.,]*(?:\s*(?:rb|ribu|k|jt|juta)\b)?`;
