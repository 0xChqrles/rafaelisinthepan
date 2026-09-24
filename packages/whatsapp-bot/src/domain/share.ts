// A Whippin share is DETERMINISTIC input (#236): the token in a `…/s/<token>` link carries
// the day and the score, decoded with the game's own codec. No model is anywhere on this
// path, and the token's day — never the WhatsApp receive date — is what groups the result.

import { PUBLIC_ID_SOURCE, SHARE_TOKEN_SOURCE, decodeResult } from '@whippin/shared';

export interface DecodedShare {
  token: string;
  lang: string;
  dayNumber: number;
  score: number; // unique tries — lower is better
  capped: boolean; // the run ended at ∞ (#214): recorded, never positioned
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A share link on the configured site. The origin is the configured site's; a link to
// some other host is somebody else's business.
function shareLink(siteOrigin: string, flags: string): RegExp {
  const host = siteOrigin.replace(/^https?:\/\//, '');
  return new RegExp(`https?://${escapeRegExp(host)}/s/`, flags);
}

// Every share link in a text, in order of appearance.
export function findShareTokens(text: string, siteOrigin: string): string[] {
  const link = shareLink(siteOrigin, 'g');
  // Sticky, so it matches AT the character after a link rather than searching on from
  // there — and built per call: a module-level sticky regex carries its `lastIndex`
  // between callers as a hidden parameter.
  const token = new RegExp(SHARE_TOKEN_SOURCE, 'y');
  const tokens: string[] = [];
  for (const match of text.matchAll(link)) {
    token.lastIndex = match.index + match[0].length;
    const found = token.exec(text);
    if (found) tokens.push(found[0]);
  }
  return tokens;
}

// THE GENERATED SHARE, AS THE WEB COMPOSES IT (`web/src/game/share.ts` `shareText`): a
// headline `Whippin AI <date> — <score> <unit>`, the run as a row of emoji (the progress
// squares and the keycaps of the solve moments), a blank line, the link. The bot cannot
// import the web, so the shape is restated here and pinned by the tests against the web's
// own output. The alphabets are the web's, verbatim: `progressEmoji`'s four squares and
// `HOLE_KEYCAPS`. A BONUS puzzle's headline names `BONUS <id>` where a day names its date.
const HEADLINE = /^[ \t]*Whippin AI (?:\d{4}-\d{2}-\d{2}|BONUS \d{7}) — [^\n]*$/u;
const ROW = /^[ \t]*(?:[🟥🟨🟪🟦]|[1-9]\uFE0F?\u20E3)+[ \t]*$/u;

const isRow = (line: string) => ROW.test(line);
const isBlank = (line: string) => line.trim() === '';

// The text WITHOUT the share it carried — the LINK, and the whole GENERATED BLOCK the web
// wrapped it in. Only the link is what the bot reads a share from, but the block beside it
// spells the same result out in words and emoji, and "a score-only share never reaches the
// provider" holds only if none of that is remembered: a message that was only a share
// comes back EMPTY and becomes no context at all, while whatever the player typed around
// it — the commentary — is what stays. A bare row of the share alphabet is dropped even
// with no headline over it (a share pasted in pieces); a headline is dropped wherever it
// stands.
export function withoutShares(text: string, siteOrigin: string): string {
  const link = shareLink(siteOrigin, 'u');
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (HEADLINE.test(line)) {
      // Skip the block: everything generated between the headline and the link line.
      let j = i + 1;
      while (j < lines.length && !link.test(lines[j]) && (isBlank(lines[j]) || isRow(lines[j]))) {
        j += 1;
      }
      // Resume AT the line the walk stopped on: the link line is kept and the link itself
      // removed below, so text typed after it on the same line survives; with no link
      // after the headline, the headline alone goes.
      i = j - 1;
      continue;
    }
    if (isRow(line)) continue;
    kept.push(line);
  }
  return kept
    .join('\n')
    // The link, and a SIGNED share's second segment with it (`/s/<token>/<publicId>`,
    // shared/invite.ts): the id names the sharer's account, which is nothing the player
    // typed and nothing a prompt should ever see.
    .replace(new RegExp(`${shareLink(siteOrigin, 'gu').source}(?:${SHARE_TOKEN_SOURCE})?(?:/${PUBLIC_ID_SOURCE})?`, 'gu'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A BONUS result (share token v7, shared bonus.ts) is no day's: it is never counted, so it
// is not a share here — only its block is dropped from the text, like any share's.
export function decodeShare(token: string): DecodedShare | null {
  const result = decodeResult(token);
  if (!result || result.dayNumber === undefined) return null;
  return {
    token,
    lang: result.lang,
    dayNumber: result.dayNumber,
    score: result.score,
    capped: result.capped === true,
  };
}

// The shares a message carries. A malformed token is simply not a share — it
// is never a reason to do anything else with the message.
export function sharesIn(text: string, siteOrigin: string): DecodedShare[] {
  const shares: DecodedShare[] = [];
  for (const token of findShareTokens(text, siteOrigin)) {
    const share = decodeShare(token);
    if (share) shares.push(share);
  }
  return shares;
}
