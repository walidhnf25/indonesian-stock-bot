/**
 * Reciprocal rank fusion: merges ranked lists from the lexical and the vector channel without having
 * to make their scores comparable. An item ranked r in a list contributes 1 / (k + r); items present in
 * both lists naturally float to the top. k = 60 is the usual constant.
 */
export interface Ranked<T> {
  item: T;
  score: number;
  /** Which channels ranked it (for explainability and tests). */
  channels: string[];
}

export function reciprocalRankFusion<T>(
  lists: Array<{ channel: string; items: T[] }>,
  key: (item: T) => string,
  k = 60,
): Ranked<T>[] {
  const acc = new Map<string, Ranked<T>>();
  for (const { channel, items } of lists) {
    items.forEach((item, index) => {
      const id = key(item);
      const entry = acc.get(id) ?? { item, score: 0, channels: [] };
      entry.score += 1 / (k + index + 1);
      entry.channels.push(channel);
      acc.set(id, entry);
    });
  }
  return [...acc.values()].sort(
    (a, b) => b.score - a.score || key(a.item).localeCompare(key(b.item)),
  );
}
