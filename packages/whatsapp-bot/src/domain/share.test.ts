import { describe, expect, it } from 'vitest';
import { dayNumber, encodeResult } from '@whippin/shared';
import { findShareTokens, sharesIn, withoutShares } from './share';

const ORIGIN = 'https://whippin.ai';

function sentenceToken(over: Partial<Parameters<typeof encodeResult>[0]> = {}): string {
  return encodeResult({
    lang: 'fr',
    dayNumber: dayNumber('2026-09-03'),
    score: 7,
    trajectory: [10, 20, 30, 40, 55, 80, 100],
    solvedAt: [3, 5, 7],
    ...over,
  });
}

describe('share links are deterministic input (#236)', () => {
  it('finds every share token in a message, and only on the configured origin', () => {
    const t = sentenceToken();
    const text = `gg https://whippin.ai/s/${t} et https://example.com/s/${t} https://whippin.ai/s/${t}.`;
    expect(findShareTokens(text, ORIGIN)).toEqual([t, t]);
  });

  // A SIGNED share (user-decided 2026-09-05) carries the sharer's publicId as a second
  // path segment. The token stops at the slash, so the bot reads a signed share exactly
  // as it reads a plain one — and the id is never attributed to anyone: the sender is the
  // WhatsApp member, as always.
  it('reads a SIGNED share link as the same token, and strips its signature with the link', () => {
    const t = sentenceToken();
    const signed = `https://whippin.ai/s/${t}/abcdefghij234567`;
    expect(findShareTokens(signed, ORIGIN)).toEqual([t]);
    expect(sharesIn(signed, ORIGIN)[0]?.token).toBe(t);
    expect(withoutShares(`gg ${signed} bravo`, ORIGIN)).toBe('gg bravo');
  });

  it('decodes a sentence result to the token\'s own day and score', () => {
    const t = sentenceToken();
    const [share] = sharesIn(`https://whippin.ai/s/${t}`, ORIGIN);
    expect(share).toMatchObject({
      token: t,
      lang: 'fr',
      dayNumber: dayNumber('2026-09-03'),
      score: 7,
      capped: false,
    });
  });

  it('keeps a capped (∞) run as a share with its flag', () => {
    const t = sentenceToken({ capped: true, solvedAt: [] });
    const [share] = sharesIn(`https://whippin.ai/s/${t}`, ORIGIN);
    expect(share?.capped).toBe(true);
  });

  // A BONUS result (share token v7, shared bonus.ts) is a test puzzle outside the calendar:
  // no day to group it under, so it is never counted — and its generated block leaves the
  // text like any share's.
  it('never counts a BONUS result, and strips its block', () => {
    const t = encodeResult({ lang: 'fr', bonusId: 1234567, score: 7, trajectory: [10, 100], solvedAt: [1, 2, 2] });
    const text = `Whippin AI BONUS 1234567 — 7 essais\n🟥🟦\n\nhttps://whippin.ai/s/${t}\ntrop dur`;
    expect(findShareTokens(text, ORIGIN)).toEqual([t]);
    expect(sharesIn(text, ORIGIN)).toEqual([]);
    expect(withoutShares(text, ORIGIN)).toBe('trop dur');
  });

  it('ignores garbage', () => {
    expect(sharesIn('https://whippin.ai/s/not-a-token!!', ORIGIN)).toEqual([]);
    expect(sharesIn('no link here', ORIGIN)).toEqual([]);
  });
});
