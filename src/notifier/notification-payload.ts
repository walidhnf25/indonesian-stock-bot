/**
 * Validation of a queued notification.
 *
 * A job read from Redis is untrusted input: whoever can write to Redis can write jobs, and a compile-time type says
 * nothing about what is really stored there. The worker therefore validates every job it consumes with
 * `parseNotification`, whoever produced it; the producer runs the same check so that a malformed notice is dropped
 * instead of queued.
 *
 * Reasons are short fixed codes: they are what gets logged and counted. The payload itself is never echoed.
 */

/** Telegram refuses a message longer than 4096 characters. */
export const MAX_NOTIFICATION_HTML_CHARS = 4096;
const MAX_CORRELATION_ID_CHARS = 100;
/** Deepest tag nesting accepted (real notices use one or two levels). */
const MAX_TAG_DEPTH = 6;

export interface Notification {
  /** Telegram user id == private chat id (always positive). */
  chatId: number;
  html: string;
  /** Added by the queue layer for log correlation. */
  correlationId?: string;
}

export type ParsedNotification = { ok: true; value: Notification } | { ok: false; reason: string };

const ALLOWED_KEYS = new Set(['chatId', 'html', 'correlationId']);

export function parseNotification(data: unknown): ParsedNotification {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'not_an_object' };
  }
  // own keys, so a "__proto__" key produced by JSON.parse is seen (and refused) too
  for (const key of Reflect.ownKeys(data)) {
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      return { ok: false, reason: 'unexpected_field' };
    }
  }
  const d = data as Record<string, unknown>;
  const chatId = d.chatId;
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId <= 0) {
    return { ok: false, reason: 'bad_chat_id' };
  }
  const html = d.html;
  if (typeof html !== 'string') return { ok: false, reason: 'bad_html_type' };
  if (html.trim().length === 0) return { ok: false, reason: 'html_empty' };
  if (html.length > MAX_NOTIFICATION_HTML_CHARS) return { ok: false, reason: 'html_too_long' };
  const correlationId = d.correlationId;
  if (
    correlationId !== undefined &&
    (typeof correlationId !== 'string' ||
      correlationId.length === 0 ||
      correlationId.length > MAX_CORRELATION_ID_CHARS)
  ) {
    return { ok: false, reason: 'bad_correlation_id' };
  }
  // Indonesian Stock Bot's queued notices (expiry, capacity, unreachable group) never carry a link; refusing links here means that
  // someone who can write to Redis cannot make the bot deliver a phishing URL.
  const markup = validateTelegramHtml(html, { allowLinks: false });
  if (markup) return { ok: false, reason: markup };
  return {
    ok: true,
    value: correlationId === undefined ? { chatId, html } : { chatId, html, correlationId },
  };
}

const SIMPLE_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
]);
/** C0 controls and DEL, except tab, line feed and carriage return. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}
const ENTITY = /^&(?:amp|lt|gt|quot);/;
const OPEN_OR_CLOSE = /^(\/)?([a-z][a-z0-9-]*)(?:\s+href="([^"<>]*)")?$/i;

/**
 * The text must be exactly the subset of Telegram HTML that Indonesian Stock Bot's own formatters produce: b/strong, i/em, u/ins,
 * s/strike/del, code, pre and <a href="http(s)://…">, properly nested and closed, with `&amp; &lt; &gt; &quot;` as the
 * only entities and no bare `<`, `>` or `&`. Anything else (scripts, images, other attributes, other schemes) is
 * refused rather than repaired. Returns null when valid, otherwise a fixed reason code.
 */
export function validateTelegramHtml(
  html: string,
  opts: { allowLinks?: boolean } = {},
): string | null {
  const allowLinks = opts.allowLinks ?? true;
  if (hasControlCharacter(html)) return 'control_character';
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '&') {
      if (!ENTITY.test(html.slice(i, i + 6))) return 'bad_entity';
      i += html.indexOf(';', i) - i + 1;
      continue;
    }
    if (ch === '>') return 'stray_bracket';
    if (ch !== '<') {
      i++;
      continue;
    }
    const end = html.indexOf('>', i);
    if (end < 0) return 'unterminated_tag';
    const inner = html.slice(i + 1, end);
    const m = OPEN_OR_CLOSE.exec(inner);
    if (!m) return 'unsupported_markup';
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const href = m[3];
    if (name !== 'a' && !SIMPLE_TAGS.has(name)) return 'unsupported_markup';
    if (closing) {
      if (href !== undefined) return 'unsupported_markup';
      if (stack.pop() !== name) return 'mismatched_tag';
    } else {
      if (name === 'a') {
        if (!allowLinks) return 'link_not_allowed';
        if (href === undefined) return 'unsupported_markup';
        const bad = linkProblem(href);
        if (bad) return bad;
      } else if (href !== undefined) {
        return 'unsupported_markup';
      }
      stack.push(name);
      if (stack.length > MAX_TAG_DEPTH) return 'too_deeply_nested';
    }
    i = end + 1;
  }
  return stack.length > 0 ? 'unclosed_tag' : null;
}

/** Only absolute http(s) links, with a well-formed entity use inside the attribute. */
function linkProblem(href: string): string | null {
  if (!/^https?:\/\/[^\s]+$/i.test(href)) return 'unsafe_link';
  for (let k = 0; k < href.length; k++) {
    if (href[k] === '&' && !ENTITY.test(href.slice(k, k + 6))) return 'bad_entity';
  }
  return null;
}
