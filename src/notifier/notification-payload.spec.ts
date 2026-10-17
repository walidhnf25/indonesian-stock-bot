import {
  MAX_NOTIFICATION_HTML_CHARS,
  parseNotification,
  validateTelegramHtml,
} from './notification-payload';

/** a queued notification is untrusted input; these are the rules the worker enforces. */
describe('parseNotification (shape)', () => {
  const ok = { chatId: 123456, html: '⚠️ <b>Alert</b> BBCA harga di atas Rp9.000' };

  it('accepts the payload Indonesian Stock Bot itself produces (with the correlation id the queue adds)', () => {
    expect(parseNotification(ok)).toMatchObject({ ok: true });
    expect(parseNotification({ ...ok, correlationId: 'send-lq3k2' })).toMatchObject({ ok: true });
  });

  it.each([
    ['missing payload', undefined, 'not_an_object'],
    ['null payload', null, 'not_an_object'],
    ['array payload', [ok], 'not_an_object'],
    ['string payload', '{"chatId":1}', 'not_an_object'],
    ['missing chatId', { html: 'x' }, 'bad_chat_id'],
    ['string chatId', { chatId: '123', html: 'x' }, 'bad_chat_id'],
    ['fractional chatId', { chatId: 12.5, html: 'x' }, 'bad_chat_id'],
    ['negative chatId (a group)', { chatId: -100123, html: 'x' }, 'bad_chat_id'],
    ['zero chatId', { chatId: 0, html: 'x' }, 'bad_chat_id'],
    ['unsafe-integer chatId', { chatId: 2 ** 60, html: 'x' }, 'bad_chat_id'],
    ['NaN chatId', { chatId: NaN, html: 'x' }, 'bad_chat_id'],
    ['missing html', { chatId: 1 }, 'bad_html_type'],
    ['numeric html', { chatId: 1, html: 12345 }, 'bad_html_type'],
    ['object html', { chatId: 1, html: { a: 1 } }, 'bad_html_type'],
    ['empty html', { chatId: 1, html: '   ' }, 'html_empty'],
    [
      'oversized html',
      { chatId: 1, html: 'A'.repeat(MAX_NOTIFICATION_HTML_CHARS + 1) },
      'html_too_long',
    ],
    ['unexpected property', { ...ok, parse_mode: 'MarkdownV2' }, 'unexpected_field'],
    ['unexpected property: recipients', { ...ok, chatIds: [1, 2, 3] }, 'unexpected_field'],
    ['non-string correlation id', { ...ok, correlationId: 5 }, 'bad_correlation_id'],
    ['huge correlation id', { ...ok, correlationId: 'c'.repeat(500) }, 'bad_correlation_id'],
  ])('refuses %s', (_name, data, reason) => {
    expect(parseNotification(data)).toEqual({ ok: false, reason });
  });

  it('refuses a __proto__ key smuggled through JSON', () => {
    const data = JSON.parse('{"chatId":1,"html":"x","__proto__":{"isAdmin":true}}');
    expect(parseNotification(data)).toEqual({ ok: false, reason: 'unexpected_field' });
  });

  it('accepts a message exactly at the length limit and refuses one char more', () => {
    expect(
      parseNotification({ chatId: 1, html: 'a'.repeat(MAX_NOTIFICATION_HTML_CHARS) }),
    ).toMatchObject({ ok: true });
    expect(
      parseNotification({ chatId: 1, html: 'a'.repeat(MAX_NOTIFICATION_HTML_CHARS + 1) }),
    ).toMatchObject({ ok: false });
  });

  it('never echoes the payload in the reason', () => {
    const r = parseNotification({ chatId: 1, html: '<script>alert("TOPSECRET")</script>' });
    expect(JSON.stringify(r)).not.toMatch(/TOPSECRET|alert/);
  });
});

describe('validateTelegramHtml (markup)', () => {
  it.each([
    'plain text, no markup at all',
    '<b>bold</b> and <i>italic</i> and <u>u</u> <s>s</s> <code>code</code>',
    '<b>nested <i>fine</i></b>',
    'S&amp;P 500 &lt; 5000 &gt; 4000 &quot;quoted&quot;',
    '<a href="https://example.com/path?a=1&amp;b=2">link</a>',
    '<a href="http://example.com">http link</a>',
    '<pre>pre\nformatted</pre>',
    'line one\nline two\ttabbed',
  ])('accepts %j', (html) => {
    expect(validateTelegramHtml(html)).toBeNull();
  });

  it.each([
    ['<script>alert(1)</script>', 'unsupported_markup'],
    ['<img src=x onerror=alert(1)>', 'unsupported_markup'],
    ['<b onclick="x()">bold</b>', 'unsupported_markup'],
    ['<iframe src="https://x"></iframe>', 'unsupported_markup'],
    ['<a href="javascript:alert(1)">x</a>', 'unsafe_link'],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', 'unsafe_link'],
    ['<a href="data:text/html;base64,AAAA">x</a>', 'unsafe_link'],
    ['<a href="tg://user?id=1">x</a>', 'unsafe_link'],
    ['<a href="">x</a>', 'unsafe_link'],
    ['<a href="https://x.com" target="_blank">x</a>', 'unsupported_markup'],
    ['<a href=https://x.com>x</a>', 'unsupported_markup'],
    ['<b>unclosed', 'unclosed_tag'],
    ['<b>wrong</i>', 'mismatched_tag'],
    ['</b>closing first', 'mismatched_tag'],
    ['<b><i>crossed</b></i>', 'mismatched_tag'],
    ['5 < 6', 'unterminated_tag'],
    ['5 < 6 and 7 > 6', 'unsupported_markup'],
    ['a <b', 'unterminated_tag'],
    ['6 > 5', 'stray_bracket'],
    ['Tom & Jerry', 'bad_entity'],
    ['&nbsp;&#60;', 'bad_entity'],
    ['bell\u0007char', 'control_character'],
    ['<b><b><b><b><b><b><b>deep</b></b></b></b></b></b></b>', 'too_deeply_nested'],
    ['<tg-spoiler>x</tg-spoiler>', 'unsupported_markup'],
  ])('refuses %j', (html, reason) => {
    expect(validateTelegramHtml(html)).toBe(reason);
  });
});

describe('queued notices carry no links (phishing through a poisoned queue)', () => {
  it.each([
    '<a href="https://evil.example/login">verifikasi akun</a>',
    'Akun kamu dikunci, <a href="http://evil.example">klik</a>',
  ])('parseNotification refuses %j', (html) => {
    expect(parseNotification({ chatId: 1, html })).toEqual({
      ok: false,
      reason: 'link_not_allowed',
    });
  });

  it('the general validator still accepts a well-formed link (only the queue channel forbids them)', () => {
    expect(validateTelegramHtml('<a href="https://example.com">ok</a>')).toBeNull();
    expect(
      validateTelegramHtml('<a href="https://example.com">ok</a>', { allowLinks: false }),
    ).toBe('link_not_allowed');
  });

  it('plain text and basic formatting are unaffected', () => {
    expect(
      parseNotification({ chatId: 1, html: '⌛ <b>Alert</b> BBCA <i>kedaluwarsa</i>' }),
    ).toMatchObject({
      ok: true,
    });
  });
});
