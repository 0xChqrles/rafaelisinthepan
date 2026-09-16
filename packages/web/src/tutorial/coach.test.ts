// CONTRACT: the reactive coach (#269). It speaks on a mistake or a stall, never on success —
// replayed here over guess sequences on a synthetic board, against the rule as decided:
//
//   - before the first guess: the goal — the clue named on the word, "two now" on the sentence;
//   - a guess that ranks but moves nothing: what the number means — ONCE, the first time;
//   - a MISS: too far to count — ONCE, the first time;
//   - a guess that moves the hole: SILENCE;
//   - a hole resisting STUCK[0] / [1] / [2] guesses: near → the board's hint → the answer;
//   - the sentence: the tap is taught after TAP_AFTER counted guesses, until it is done, and
//     never while a hint or the answer is due; the away / miss lines belong to the word stage.
//   Every line is written for someone who has never heard of the game: it names the HIDDEN
//   WORD the numbers are about (coachCopy below).
import { describe, it, expect } from 'vitest';
import type { RankEntry, RuntimeHole } from '@whippin/shared';
import { coachLine, coachCopy, ordinal, STUCK, TAP_AFTER, type CoachState, type GuessEvent, type Stage } from './coach';
import type { LessonStage } from './script';

const entry = (word: string, rank: number): RankEntry => ({ word, rank, dq: rank === 0 ? undefined : 100 } as RankEntry);

// A board of `n` holes at their start ranks, and a way to replay typed guesses through it —
// the same reading LessonBoard makes (entries per open hole, improved where the rank falls).
function board(stage: Stage, starts: number[]) {
  const holes: RuntimeHole[] = starts.map((rank, i) => ({
    pos: i,
    secret: `s${i}`,
    word: `start${i}`,
    rank,
    startRank: rank,
  }));
  const events: GuessEvent[] = [];
  const state = (tapped = false): CoachState => ({ stage, holes, events, tapped });
  // `ranks[i]` is the guess's rank on hole i, or null for a MISS there.
  const guess = (typed: string, ranks: (number | null)[]) => {
    const entries = holes.map((h, i) => (h.rank === 0 || ranks[i] === null ? undefined : entry(typed, ranks[i] as number)));
    const improved = holes.map((h, i) => entries[i] !== undefined && (entries[i] as RankEntry).rank < h.rank);
    events.push({ typed, entries, improved });
    holes.forEach((h, i) => {
      if (improved[i]) {
        h.rank = (entries[i] as RankEntry).rank;
        h.word = typed;
      }
    });
  };
  return { state, guess, holes };
}

describe('the word stage', () => {
  it('opens on the goal and falls silent on an improving guess', () => {
    const b = board('word', [10]);
    expect(coachLine(b.state())).toEqual({ kind: 'intro', hole: expect.objectContaining({ word: 'start0', rank: 10 }) });
    b.guess('sea', [3]);
    expect(coachLine(b.state())).toBeNull();
  });

  it('explains the number on the FIRST ranked guess that moves nothing, once', () => {
    const b = board('word', [10]);
    b.guess('boat', [45]);
    expect(coachLine(b.state())).toEqual({
      kind: 'away',
      guess: expect.objectContaining({ word: 'boat', rank: 45 }),
      hole: expect.objectContaining({ word: 'start0', rank: 10 }),
    });
    b.guess('ship', [24]);
    expect(coachLine(b.state())).toBeNull();
  });

  it('names the first MISS, once', () => {
    const b = board('word', [10]);
    b.guess('violin', [null]);
    expect(coachLine(b.state())).toEqual({ kind: 'miss', typed: 'violin' });
    b.guess('sea', [3]); // silence: it moved
    b.guess('guitar', [null]);
    expect(coachLine(b.state())).toBeNull(); // the second miss says nothing new
  });

  it('climbs the ladder while the hole resists: near, then the hint, then the answer', () => {
    const [near, hint, answer] = STUCK.word;
    const b = board('word', [10]);
    for (let i = 0; i < near; i += 1) b.guess(`w${i}`, [40 + i]);
    expect(coachLine(b.state())).toEqual({ kind: 'near', hole: expect.objectContaining({ rank: 10 }) });
    for (let i = near; i < hint; i += 1) b.guess(`w${i}`, [null]);
    expect(coachLine(b.state())).toEqual({ kind: 'hint', holeIndex: 0 });
    for (let i = hint; i < answer; i += 1) b.guess(`w${i}`, [40 + i]);
    expect(coachLine(b.state())).toEqual({ kind: 'answer', holeIndex: 0 });
    // A guess that moves the hole resets the count: the coach steps back down.
    b.guess('sea', [3]);
    expect(coachLine(b.state())).toBeNull();
  });
});

describe('the sentence stage', () => {
  it('opens on its own line, says nothing on away or miss, and teaches the tap after TAP_AFTER guesses until it is done', () => {
    const b = board('sentence', [55, 62]);
    expect(coachLine(b.state())).toEqual({ kind: 'introSentence' });
    b.guess('a', [90, null]);
    expect(coachLine(b.state())).toBeNull();
    b.guess('b', [12, 30]);
    expect(coachLine(b.state())).toBeNull();
    b.guess('c', [5, 20]);
    expect(b.state().events).toHaveLength(TAP_AFTER);
    expect(coachLine(b.state())).toEqual({ kind: 'tap' });
    expect(coachLine(b.state(true))).toBeNull();
  });

  it('nudges toward the hole that has resisted longest, and the hint outranks the tap', () => {
    const [near, hint] = STUCK.sentence;
    const b = board('sentence', [55, 62]);
    // Every guess moves hole 0 and does nothing for hole 1.
    for (let i = 0; i < near; i += 1) b.guess(`w${i}`, [50 - i, 200]);
    // The tap is due too (TAP_AFTER ≤ near) and wins over near…
    expect(coachLine(b.state())).toEqual({ kind: 'tap' });
    expect(coachLine(b.state(true))).toEqual({ kind: 'near', hole: expect.objectContaining({ rank: 62 }) });
    for (let i = near; i < hint; i += 1) b.guess(`w${i}`, [50 - i, null]);
    // …but the hint wins over the tap.
    expect(coachLine(b.state())).toEqual({ kind: 'hint', holeIndex: 1 });
  });

  it('a found hole resists nothing', () => {
    const b = board('sentence', [55, 62]);
    b.guess('dog', [0, null]);
    for (let i = 0; i < STUCK.sentence[2]; i += 1) b.guess(`w${i}`, [null, 200]);
    expect(coachLine(b.state(true))).toEqual({ kind: 'answer', holeIndex: 1 });
  });
});

describe('ordinal', () => {
  it('counts in English and French ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((n) => ordinal('en', n))).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th',
    ]);
    expect([1, 2, 21].map((n) => ordinal('fr', n))).toEqual(['1er', '2e', '21e']);
  });
});

describe('coachCopy', () => {
  const stage: LessonStage = {
    puzzle: {
      lang: 'en',
      revision: 'lesson',
      words: ['ocean'],
      holes: [{ pos: 0, secret: { word: 'ocean', slug: 'ocean' }, start: { word: 'islands', slug: 'islands' }, start_rank: 10 }],
      ranks: { ocean: {} },
    },
    hints: ['tutHintOcean'],
  };
  it('prints the board’s words in their in-game dress', () => {
    const hole: RuntimeHole = { pos: 0, secret: 'ocean', word: 'islands', rank: 10, startRank: 10 };
    expect(coachCopy('en', { kind: 'intro', hole }, stage, true)).toBe(
      'Guess the secret word. [[w:islands^10]] is the word closest to it in meaning.',
    );
    expect(coachCopy('en', { kind: 'away', guess: entry('boat', 45), hole }, stage, true)).toBe(
      '[[w:boat^45]] is the 45th closest word to the secret. [[w:islands^10]] is the 10th.',
    );
    expect(coachCopy('fr', { kind: 'away', guess: entry('bateau', 21), hole: { ...hole, rank: 1 } }, stage, true)).toBe(
      '[[w:bateau^21]] est le 21e mot le plus proche du secret. [[w:islands^1]] est le 1er.',
    );
    expect(coachCopy('en', { kind: 'miss', typed: 'violin' }, stage, true)).toBe(
      '[[m:violin]] is too far from the secret to even get a number.',
    );
    expect(coachCopy('en', { kind: 'near', hole }, stage, true)).toBe(
      'Try words with a meaning close to [[w:islands^10]].',
    );
    expect(coachCopy('en', { kind: 'answer', holeIndex: 0 }, stage, true)).toBe('The secret word is [[b:ocean]]. Type it.');
    expect(coachCopy('en', { kind: 'tap' }, stage, true)).toMatch(/^Tap/);
    expect(coachCopy('en', { kind: 'tap' }, stage, false)).toMatch(/^Click/);
  });
});
