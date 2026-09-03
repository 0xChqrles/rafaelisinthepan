// A Whippin share is DETERMINISTIC input (#236): the token in a `…/s/<token>` link carries
// the day and the score, decoded with the game's own codec. No model is anywhere on this
// path, and the token's day — never the WhatsApp receive date — is what groups the result.
//
// Only SENTENCE results take part: a word-mode token decodes to nothing here, since the
// group has no product rule for what ranking a rarity score against a try count would mean.

import { decodeResult, type ShareResult } from '@whippin/shared';

export interface DecodedShare {
  token: string;
  lang: string;
  dayNumber: number;
  score: number; // unique tries — lower is better
  capped: boolean; // the run ended at ∞ (#214): recorded, never positioned
}

const TOKEN = /[A-Za-z0-9_-]+/y;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every share link in a text, in order of appearance. The origin is the configured site's;
// a link to some other host is somebody else's business.
export function findShareTokens(text: string, siteOrigin: string): string[] {
  const host = siteOrigin.replace(/^https?:\/\//, '');
  const link = new RegExp(`https?://${escapeRegExp(host)}/s/`, 'g');
  const tokens: string[] = [];
  for (const match of text.matchAll(link)) {
    TOKEN.lastIndex = match.index + match[0].length;
    const token = TOKEN.exec(text);
    if (token) tokens.push(token[0]);
  }
  return tokens;
}

export function decodeShare(token: string): DecodedShare | null {
  const result: ShareResult | null = decodeResult(token);
  if (!result) return null;
  return {
    token,
    lang: result.lang,
    dayNumber: result.dayNumber,
    score: result.score,
    capped: result.capped === true,
  };
}

// The sentence shares a message carries. A malformed token is simply not a share — it is
// never a reason to do anything else with the message.
export function sharesIn(text: string, siteOrigin: string): DecodedShare[] {
  const shares: DecodedShare[] = [];
  for (const token of findShareTokens(text, siteOrigin)) {
    const share = decodeShare(token);
    if (share) shares.push(share);
  }
  return shares;
}
