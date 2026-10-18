// WHAT A REPLY LOOKS LIKE ON WHATSAPP (v22, 2026-10-18). Until v21 every reply was flattened
// to bare text — every `* _ ~ \` #` removed — which was right for a bot that only ever
// typed one line, and which broke every link it would now give (`wiki/Le_Petit_Prince`
// became `wiki/LePetitPrince`, `page#history` lost its anchor). WhatsApp draws its own
// formatting (*bold*, _italics_, ~strike~, `code`, "- " lists), so that is kept, the
// Markdown a model writes anyway is turned into it, and a link is never touched: it is
// lifted out before anything else runs and put back as it was.

// WhatsApp takes ~65k characters; a reply is "a few short paragraphs or a short list at
// most" (`personality.ts` `conversationSection`), and this is where the code holds it.
export const REPLY_MAX_CHARS = 3000;

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?'"»”’]+$/;

// A URL as it ends in running text: a full stop or a closing bracket after it is the
// sentence's, unless the link opened that bracket itself (`…/Paris_(France)`).
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) {
      url = url.slice(0, -1).replace(TRAILING, '');
    }
  }
  return url;
}

// The links a text holds, as they would be clicked.
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((m) => trimUrl(m[0])).filter((u) => u.length > 'https://'.length);
}

// One page, however it was spelled: scheme and host case, a default port, a fragment and a
// trailing slash do not make another page. `withQuery: false` also drops the query — what a
// link the bot GIVES is compared on, since a model tidies tracking parameters away.
export function linkKey(url: string, withQuery = true): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.host.toLowerCase().replace(/^www\./, '')}${path}${withQuery ? u.search : ''}`;
  } catch {
    return null;
  }
}

// Markdown → WhatsApp, outside the links.
function whatsappMarks(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*') // a heading is a bold line
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '') // a rule is nothing
    .replace(/^(\s*)[*+]\s+/gm, '$1- ') // a bullet is "- "
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '*$1*')
    .replace(/__(?=\S)([^_\n]+?)__/g, '_$1_')
    .replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~');
}

// The cut, never inside a link: at a paragraph, a line or a sentence end past half the room,
// else at a space, else just before the link that would have been split.
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const links = [...text.matchAll(URL_PATTERN)].map((m) => [m.index, m.index + m[0].length] as const);
  const inLink = (i: number) => links.some(([a, b]) => i > a && i < b);
  const head = text.slice(0, max);
  for (const end of [/\n\n/g, /\n/g, /[.!?…](?=\s)/g]) {
    const at = [...head.matchAll(end)].map((m) => m.index + (m[0].startsWith('\n') ? 0 : 1)).filter((i) => i > max / 2 && !inLink(i));
    if (at.length > 0) return text.slice(0, at[at.length - 1]).trim();
  }
  const space = [...head.matchAll(/\s/g)].map((m) => m.index).filter((i) => !inLink(i));
  if (space.length > 0) return text.slice(0, space[space.length - 1]).trim();
  const split = links.find(([a, b]) => a < max && b > max);
  return text.slice(0, split ? split[0] : max).trim();
}

// One WhatsApp message: control characters out, Markdown turned into WhatsApp's own marks,
// a Markdown link written as its text and the link itself, links untouched, at most one
// blank line in a row, bounded length. Null when nothing is left.
export function replyText(raw: string | null): string | null {
  if (!raw) return null;
  const kept: string[] = [];
  const hold = (url: string) => `\u0000${kept.push(url) - 1}\u0000`;
  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    // [text](url): the text, then the link — the same link alone when the text was the link.
    .replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g, (_, label: string, url: string) => {
      const name = label.trim();
      return !name || urlsIn(name).length > 0 || name === url ? hold(url) : `${name} ${hold(url)}`;
    })
    .replace(URL_PATTERN, (raw) => {
      const url = trimUrl(raw);
      return hold(url) + raw.slice(url.length);
    });
  text = whatsappMarks(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
  text = cutAt(text, REPLY_MAX_CHARS);
  return text === '' ? null : text;
}

// The reply with every link it was never shown taken out (v22): a link the bot gives comes
// from a search result, a page it read or the conversation — a made-up one is a dead end at
// best, and the group clicks it on the bot's word. `allowed` answers for one link. Only a
// line that lost a link is tidied, and only of what the link left behind (a dangling colon,
// a space before a comma, an empty bullet): French spaces its « ? » and « : », and a line
// nothing was taken from is left exactly as written.
export function withoutUnseenLinks(text: string, allowed: (url: string) => boolean): string {
  let changed = false;
  const lines = text.split('\n').flatMap((line) => {
    let lost = false;
    let left = line.replace(URL_PATTERN, (raw) => {
      const url = trimUrl(raw);
      if (allowed(url)) return raw;
      lost = true;
      return raw.slice(url.length); // what followed the link (a full stop) stays
    });
    if (!lost) return [line];
    changed = true;
    left = left
      .replace(/\(\s*\)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.)])/g, '$1')
      .replace(/[ \t]*[:—–-]?[ \t]*$/, '');
    // A line that was only the link (a bullet of it, a full stop after it) goes with it.
    return /[\p{L}\p{N}]/u.test(left) ? [left] : [];
  });
  return changed ? lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() : text;
}
