export const BODY_LIMIT = 20_000;
export const DOWNLOAD_LIMIT = 1_000_000;

/** Strip controls, direction overrides and invisible formatting before making a view. */
export function cleanMailText(value: string, limit = BODY_LIMIT): string {
  return value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]|[\u{e0000}-\u{e0fff}]/gu, '')
    .replace(/[\u2013\u2014]/g, '-').slice(0, limit).replace(/[\ud800-\udbff]$/, '');
}

function entities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}

/** A bounded, non-rendering tokenizer. Nothing is executed, fetched or passed to a DOM. */
export function mailToText(input: string, html = true, limit = BODY_LIMIT): string {
  const source = input.slice(0, DOWNLOAD_LIMIT);
  // Plain text is never tokenized: "<https://...>", "<anna@...>" and a stray "<" are
  // part of the text. It goes to the renderer as text (textContent) either way.
  if (!html) return cleanMailText(source, limit);
  const output: string[] = [];
  let hidden: string | null = null;
  let link = '';
  let at = 0;
  while (at < source.length) {
    if (source[at] !== '<') {
      const end = source.indexOf('<', at);
      const next = end < 0 ? source.length : end;
      if (!hidden) output.push(entities(source.slice(at, next)));
      at = next;
      continue;
    }
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    let end = at + 1;
    let quote = '';
    for (; end < source.length; end++) {
      const ch = source[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    // Fail closed on a truncated tag (including a truncated quoted attribute).
    if (end === source.length) break;
    const tag = source.slice(at + 1, end);
    const match = /^\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(tag);
    at = end + 1;
    if (!match) continue;
    const closing = !!match[1];
    const name = match[2].toLowerCase();
    if (hidden) { if (closing && name === hidden) hidden = null; continue; }
    if (!closing && /^(script|style|iframe|object|svg|math|head|template)$/.test(name)) { hidden = name; continue; }
    if (name === 'a') {
      if (closing) { if (link) output.push(` (${link})`); link = ''; }
      else {
        if (link) output.push(` (${link})`);
        const href = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const value = cleanMailText(entities(href?.[1] ?? href?.[2] ?? href?.[3] ?? ''), 2048).trim();
        try {
          const url = new URL(value);
          link = ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : '';
        } catch { link = ''; }
      }
    }
    if (/^(br|p|div|li|tr|h[1-6]|blockquote|pre|hr)$/.test(name)) output.push('\n');
  }
  if (link) output.push(` (${link})`);
  // Decoded entities must not reintroduce tags, even if a future consumer misuses this text.
  return cleanMailText(output.join('').replace(/[<>]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), limit);
}
