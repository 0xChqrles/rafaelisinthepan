import { describe, expect, it } from 'vitest';
import { dayNumber, encodeResult, progressEmoji, shareHeadline } from '@whippin/shared';
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
    // The block as the web composes it, from the shared halves of that composition.
    const headline = shareHeadline({ bonusId: 1234567 }, 7, 'essais');
    const text = `${headline}\n${progressEmoji(10)}${progressEmoji(100)}\n\nhttps://whippin.ai/s/${t}\ntrop dur`;
    expect(findShareTokens(text, ORIGIN)).toEqual([t]);
    expect(sharesIn(text, ORIGIN)).toEqual([]);
    expect(withoutShares(text, ORIGIN)).toBe('trop dur');
  });

  it('ignores garbage', () => {
    expect(sharesIn('https://whippin.ai/s/not-a-token!!', ORIGIN)).toEqual([]);
    expect(sharesIn('no link here', ORIGIN)).toEqual([]);
  });
});

describe('what a share message contributes (#236)', () => {
  // THE GENERATED SHARE as the web sends it (`web/src/game/share.ts` `shareText`): a
  // headline, the run as emoji, a blank line, the link. The bot cannot import the web, so
  // the fixtures are built from the halves of it that ARE shared — the headline is
  // `shareHeadline`'s own output, the squares `progressEmoji`'s — and a change to either
  // format fails here. Only the keycaps (the web's `HOLE_KEYCAPS`) are typed by hand.
  const DAY = dayNumber('2026-09-03');
  const HEADLINE = shareHeadline({ dayNumber: DAY }, 7, 'essais');
  const [RED, AMBER, ORCHID, BLUE] = [0, 30, 60, 100].map(progressEmoji);
  const SENTENCE = `${HEADLINE}\n${RED}${AMBER}1️⃣2️⃣3️⃣\n\n${ORIGIN}/s/ZBXY-GMSYiy-73w`;
  const CAPPED = `${shareHeadline({ dayNumber: DAY }, '∞', 'essais')}\n${RED}${RED}${AMBER}\n\n${ORIGIN}/s/ZBXefoGN______-A`;

  it('drops the WHOLE generated share — headline, row and link — not only the link', () => {
    // The link is what the bot reads a share from, but the block beside it spells the
    // same result out in words and emoji. "A score-only share never reaches the provider"
    // holds only if none of it is remembered: a message that was only a share is EMPTY.
    for (const share of [SENTENCE, CAPPED]) {
      expect(withoutShares(share, ORIGIN)).toBe('');
    }
  });

  it('keeps what the player typed around the share — the commentary is the conversation', () => {
    expect(withoutShares(`gg\n${SENTENCE}`, ORIGIN)).toBe('gg');
    expect(withoutShares(`${SENTENCE}\ntrop dur aujourd'hui`, ORIGIN)).toBe("trop dur aujourd'hui");
    // Two shares in one message, words between them.
    expect(withoutShares(`hier\n${SENTENCE}\net aujourd'hui\n${CAPPED}`, ORIGIN)).toBe("hier et aujourd'hui");
  });

  it('strips the token whether the message was addressed to the bot or not', () => {
    const addressed = `gg 7 essais ${ORIGIN}/s/ZBXg-ISaks2-fA @WhippinBot qui mène ?`;
    const stripped = withoutShares(addressed, ORIGIN);
    expect(stripped).toBe('gg 7 essais @WhippinBot qui mène ?');
    expect(stripped).not.toContain('ZBXg');
    expect(withoutShares(`${SENTENCE} @WhippinBot qui mène ?`, ORIGIN)).toBe('@WhippinBot qui mène ?');
  });

  it('drops the pieces of a share pasted apart, and nothing a person would say', () => {
    expect(withoutShares(`${ORIGIN}/s/ZBXg-ISaks2-fA`, ORIGIN)).toBe('');
    expect(withoutShares(HEADLINE, ORIGIN)).toBe('');
    expect(withoutShares(`${RED}${AMBER}${ORCHID}${BLUE}2️⃣`, ORIGIN)).toBe('');
    expect(withoutShares('BRAVO', ORIGIN)).toBe('BRAVO');
    expect(withoutShares(`PHARE\n${SENTENCE}`, ORIGIN)).toBe('PHARE');
    expect(withoutShares('trop fort 🟦🟦', ORIGIN)).toBe('trop fort 🟦🟦');
    expect(withoutShares(`a ${ORIGIN}/s/AAA et ${ORIGIN}/s/BBB b`, ORIGIN)).toBe('a et b');
    expect(withoutShares('https://example.com/s/AAA', ORIGIN)).toBe('https://example.com/s/AAA');
  });
});
