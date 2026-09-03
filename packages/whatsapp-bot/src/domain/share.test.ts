import { describe, expect, it } from 'vitest';
import { dayNumber, encodeResult, encodeWordResult } from '@whippin/shared';
import { findShareTokens, sharesIn } from './share';

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
    expect(sharesIn(`https://whippin.ai/s/${t}`, ORIGIN)[0]?.capped).toBe(true);
  });

  it('ignores word-mode tokens and garbage', () => {
    const word = encodeWordResult({
      lang: 'fr',
      dayNumber: dayNumber('2026-09-03'),
      word: 'phare',
      counts: [1, 2, 3, 0, 0],
    });
    expect(sharesIn(`https://whippin.ai/s/${word}`, ORIGIN)).toEqual([]);
    expect(sharesIn('https://whippin.ai/s/not-a-token!!', ORIGIN)).toEqual([]);
    expect(sharesIn('no link here', ORIGIN)).toEqual([]);
  });
});
