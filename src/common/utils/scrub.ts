/** Removes secrets (bot tokens, api keys, DB passwords) from any text before logging. */

/**
 * Longest text a scrub looks at. Every pattern is linear, but error bodies can be huge and the work should
 * not depend on what an upstream sends; anything beyond this is cut.
 */
export const MAX_SCRUB_INPUT = 10_000;

/**
 * Names whose value is a secret: PASSWORD, DB_PASSWORD, OPENAI_API_KEY, bearer TOKEN, authorization,
 * secret_value, access_token_id... (a prefix of word characters and a small set of suffixes are allowed).
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|authorization)(?:[_-]?(?:value|key|id|hash|string|code))?`;
/** "=" or ":" (also URL-encoded) between a name and its value. */
const SEP = String.raw`\s*(?:[=:]|%3[DdAa])\s*`;

const PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens appear as "123456789:AAH..." and inside API URLs as "/bot123456789:AAH...".
  // The colon can also be URL-encoded (%3A).
  [/(?<![0-9])\d{6,}(?::|%3A)[A-Za-z0-9_-]{30,}/gi, '[REDACTED_TELEGRAM_TOKEN]'],
  // user:password@host in ANY URL (postgres, http, redis...). The scheme is bounded so the match cannot
  // restart from every position of a long separator-rich string.
  [
    /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,20}:\/\/[^:\s/@]{0,200}:)[^@\s/]{1,500}@/gi,
    '$1[REDACTED]@',
  ],
  [/((?:^|[?&;\s])(?:key|api_key|apikey|token)=)[^&\s]+/gi, '$1[REDACTED]'],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]'],
  // JSON-style: "password":"x", "api_key": "x", 'token': 'x'
  [
    new RegExp(String.raw`(["']${SECRET_NAME}["']\s*:\s*)(["'])(?:(?!\2).)*\2`, 'gi'),
    '$1"[REDACTED]"',
  ],
  // key=value / key: value with a quoted value (may contain spaces): password="a b", secret='x y'
  [new RegExp(String.raw`(\b${SECRET_NAME}${SEP})(["'])(?:(?!\2).)*\2`, 'gi'), '$1[REDACTED]'],
  // key=value / key: value, unquoted: "password=hunter2", "TOKEN: abc", "OPENAI_API_KEY=sk-x"
  [new RegExp(String.raw`(\b${SECRET_NAME}${SEP})(?:bearer\s+)?[^\s,;&"']+`, 'gi'), '$1[REDACTED]'],
];

export function scrub(text: string): string {
  const bounded = text.length > MAX_SCRUB_INPUT ? `${text.slice(0, MAX_SCRUB_INPUT)}…` : text;
  return PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), bounded);
}

export function safeErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return scrub(msg).slice(0, 500);
}
