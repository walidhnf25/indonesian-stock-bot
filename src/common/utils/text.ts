/**
 * Text that comes from outside the application (a provider's company name) and may end up in a prompt,
 * a log line, the database or a Telegram message. Control, invisible and bidirectional characters are
 * removed, brackets/quotes that could forge markup or a prompt block are dropped, whitespace collapses
 * and the length is bounded.
 */
const MAX_NAME_LENGTH = 80;

/* eslint-disable no-control-regex, no-misleading-character-class */
const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF]/g;
/* eslint-enable no-control-regex, no-misleading-character-class */
const MARKUP = /[<>{}[\]"`\\]/g;

export function cleanCompanyName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFKC')
    .replace(INVISIBLE, ' ')
    .replace(MARKUP, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
