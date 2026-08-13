// CONTRACT (#156 Word mode, retimed by #163 — decided 2026-08-08):
//   - score = number of top-zone (CLAIM_ZONE) groups claimed, and that COUNT is stated to
//     the player on the gate — read off the constant, never spelled into the copy;
//   - a claim also ADDS SECONDS to the clock, by the claimed group's RARITY GRADE — one of
//     five named grades (COMMON..ARCANE) read off its `freq` as a fraction of the LANGUAGE'S
//     WHOLE CORPUS, never an absolute frequency rank: the two languages' vocabularies are
//     very different sizes, and absolute cutoffs made the same word mean different things in
//     them. The seconds are EXPONENTIAL across the grades, so depth pays. Rarity feeds the
//     CLOCK only, never the score — one resource, one number;
//   - a near miss (ranked, outside the zone) and a miss (off-map) add nothing and cost
//     nothing but the time spent typing. Nothing ends a run except the DEADLINE, which
//     this module deliberately does not know: `replayWordRun` reports no `ended`;
//   - free (no claim, no bonus): repeats — deduped at GROUP level (#104: inflections/
//     aliases of a tried group are a repeat) — and the day's word itself (it is public).
// Every number below is DERIVED from the tuning knobs, never typed out, so retuning the
// economy stays the one-line change the module promises.
// Asserted against the spec, not the implementation.

import { describe, it, expect } from 'vitest';
import type { WordRanks } from '@whippin/shared';
import {
  CLAIM_ZONE,
  RARITY_LADDER,
  RARITY_NAMES,
  START_SECONDS,
  bonusSeconds,
  judgeWordGuess,
  rarityOf,
  rarityStep,
  replayWordRun,
  runMs,
  totalBonus,
  wordGuessKey,
} from './wordGame';
import { t, tn } from '../i18n';

// A corpus to measure rarity against. Round, so a grade's `within` fraction reads straight
// off a `freq` in the fixture below.
const CORPUS = 100_000;
// A `freq` that lands INSIDE grade `index`: just under its ceiling, or well past the last
// grade's (which is unbounded by construction).
const inGrade = (index: number): number =>
  Number.isFinite(RARITY_LADDER[index].within)
    ? Math.floor(RARITY_LADDER[index].within * CORPUS)
    : CORPUS * 10;
const LAST = RARITY_LADDER.length - 1;

// A small map exercising every boundary: the word itself (rank 0, aliased), an aliased
// zone group (rank 1), more zone groups, the LAST zone rank, the first rank past the
// zone (aliased), and a far one. The zone groups carry `freq` values from opposite ends
// of the rarity ladder, so a run's clock is not one flat number.
const RANKS: WordRanks = {
  tropiques: { word: 'tropiques', rank: 0 },
  tropique: { word: 'tropiques', rank: 0 },
  tropicales: { word: 'tropicales', rank: 1, dq: 255, freq: inGrade(0) },
  tropical: { word: 'tropicales', rank: 1, dq: 255, freq: inGrade(0) },
  cocotier: { word: 'cocotier', rank: 2, dq: 236, freq: inGrade(LAST) },
  lagon: { word: 'lagon', rank: CLAIM_ZONE, dq: 40 }, // no freq: a borrowed-vector group
  sable: { word: 'sable', rank: CLAIM_ZONE + 1, dq: 39 },
  sables: { word: 'sable', rank: CLAIM_ZONE + 1, dq: 39 },
  // Well outside the zone but still ON the map — a far near miss. Derived like every other
  // rank here: it was a literal 353 until 2026-08-11, when the zone widened past it and
  // silently turned this fixture's far miss into a claim.
  neige: { word: 'neige', rank: CLAIM_ZONE + 100, dq: 12 },
};

// What a log is worth, priced against the fixture's corpus.
const bonusOf = (tried: string[]): number => totalBonus(replayWordRun(RANKS, tried).claimed, CORPUS);

// CLAIM_ZONE is pinned to nothing: every rank up to TOP_K carries the `freq` the board
// colours a station by and the `dq` it spaces one by, so the zone is this package's own
// tuning knob, freely movable with no republish.

describe('judgeWordGuess — the claim boundary', () => {
  it('a zone group is a claim, the zone edge included', () => {
    expect(judgeWordGuess(RANKS, 'tropicales').kind).toBe('claim');
    expect(judgeWordGuess(RANKS, 'lagon').kind).toBe('claim'); // rank == CLAIM_ZONE
  });

  it('the first rank past the zone is a near miss (its rank teaches the boundary)', () => {
    const judged = judgeWordGuess(RANKS, 'sable');
    expect(judged.kind).toBe('near');
    if (judged.kind === 'near') expect(judged.entry.rank).toBe(CLAIM_ZONE + 1);
  });

  it('off-map (no entry at all) is a miss with no rank', () => {
    expect(judgeWordGuess(RANKS, 'guitare').kind).toBe('miss');
  });

  it('the day\'s word itself (rank 0) is free — it is public', () => {
    expect(judgeWordGuess(RANKS, 'tropiques').kind).toBe('zero');
    expect(judgeWordGuess(RANKS, 'tropique').kind).toBe('zero'); // via an alias too
  });
});

describe('wordGuessKey — group-level identity (#104)', () => {
  it('aliases of one group share one identity', () => {
    expect(wordGuessKey(RANKS, 'tropical')).toBe(wordGuessKey(RANKS, 'tropicales'));
    // Group identity also holds outside the zone: an inflection of a counted near
    // miss is the same guess.
    expect(wordGuessKey(RANKS, 'sable')).toBe(wordGuessKey(RANKS, 'sables'));
  });

  it('distinct off-map words are distinct guesses (slug fallback)', () => {
    expect(wordGuessKey(RANKS, 'guitare')).not.toBe(wordGuessKey(RANKS, 'violon'));
  });
});

describe('rarityOf — five named grades, measured against the CORPUS', () => {
  it('names the five grades, commonest first, and the ladder is total', () => {
    expect(RARITY_LADDER.map((g) => g.name)).toEqual([...RARITY_NAMES]);
    // Ordered, so the "first grade it fits in" lookup is the right one...
    const cuts = RARITY_LADDER.map((g) => g.within);
    expect(cuts).toEqual([...cuts].sort((a, b) => a - b));
    // ...and unbounded at the top, so no word can fall off the end ungraded.
    expect(cuts[LAST]).toBe(Infinity);
  });

  it('a grade is a FRACTION of the corpus, so the same word grades alike in any language', () => {
    // The identical position in two differently sized vocabularies is a different rarity;
    // the identical FRACTION is the same one. That is the whole reason corpusSize is an
    // argument — with absolute cutoffs, English and French zones graded ~55% apart.
    const fraction = RARITY_LADDER[1].within;
    for (const corpus of [50_000, 100_000, 400_000]) {
      expect(rarityOf(Math.floor(fraction * corpus), corpus)).toBe(RARITY_NAMES[1]);
      // Just past that fraction is the next grade up, at every corpus size.
      expect(rarityOf(Math.ceil(fraction * corpus) + 1, corpus)).toBe(RARITY_NAMES[2]);
    }
  });

  it('grades every band, including the unbounded tail', () => {
    for (let i = 0; i <= LAST; i += 1) {
      expect(rarityOf(inGrade(i), CORPUS)).toBe(RARITY_NAMES[i]);
      expect(rarityStep(RARITY_NAMES[i])).toBe(i);
    }
  });

  it('an unknown or unusable rarity falls to the FLOOR, never a windfall', () => {
    // `freq` is optional per entry by contract (a borrowed-vector group carries none), and
    // a missing corpus must not divide by zero into a jackpot.
    expect(rarityOf(undefined, CORPUS)).toBe(RARITY_NAMES[0]);
    expect(rarityOf(500, 0)).toBe(RARITY_NAMES[0]);
  });
});

describe('bonusSeconds — what a claim pays the clock (#163)', () => {
  it('pays its grade, and rarer is always worth strictly more', () => {
    const paid = RARITY_LADDER.map((_g, i) => bonusSeconds(inGrade(i), CORPUS));
    expect(paid).toEqual(RARITY_LADDER.map((g) => g.seconds));
    for (let i = 1; i <= LAST; i += 1) expect(paid[i]).toBeGreaterThan(paid[i - 1]);
  });

  it('the ladder is EXPONENTIAL, not linear — depth pays off, it does not merely tick up', () => {
    // The asked-for shape: each step MULTIPLIES. A linear ladder has constant differences,
    // which is exactly what this rejects — every gap must be wider than the one below it,
    // and the top must be a real jackpot rather than one more increment.
    const paid = RARITY_LADDER.map((g) => g.seconds);
    for (let i = 2; i <= LAST; i += 1) {
      expect(paid[i] - paid[i - 1], `gap ${i}`).toBeGreaterThan(paid[i - 1] - paid[i - 2]);
    }
    expect(paid[LAST]).toBeGreaterThanOrEqual(4 * paid[0]);
  });

  it('an unknown rarity pays the floor (freq is optional by contract)', () => {
    expect(bonusSeconds(undefined, CORPUS)).toBe(RARITY_LADDER[0].seconds);
  });
});

describe('replayWordRun — the score and the clock, from the log alone', () => {
  it('claims count; the score is the claim count', () => {
    const run = replayWordRun(RANKS, ['tropicales', 'cocotier']);
    expect(run.claimed.map((e) => e.rank)).toEqual([1, 2]);
  });

  it('the clock gets the SUM of the claims\' grades — rarity feeds it, not the score', () => {
    const run = replayWordRun(RANKS, ['tropicales', 'cocotier']);
    // Two claims, one common and one deep in the tail: the SCORE cannot tell them apart
    // (both are one word), the clock must.
    expect(run.claimed).toHaveLength(2);
    const bonus = totalBonus(run.claimed, CORPUS);
    expect(bonus).toBe(RARITY_LADDER[0].seconds + RARITY_LADDER[LAST].seconds);
    // A bonus second is a REAL second of run: independent facts about runMs, not its
    // formula restated (which proved nothing) — a run opens at START_SECONDS, and each
    // second a claim buys is worth exactly 1000ms of deadline.
    expect(runMs(0)).toBe(START_SECONDS * 1000);
    expect(runMs(bonus) - runMs(0)).toBe(bonus * 1000);
  });

  it('a claim on a group with no freq still pays the floor', () => {
    const run = replayWordRun(RANKS, ['lagon']);
    expect(run.claimed.map((e) => e.rank)).toEqual([CLAIM_ZONE]);
    expect(bonusOf(['lagon'])).toBe(RARITY_LADDER[0].seconds);
  });

  it('near misses and misses buy nothing and cost nothing', () => {
    const run = replayWordRun(RANKS, ['sable', 'neige', 'guitare', 'violon']);
    expect(run.claimed).toEqual([]);
    expect(bonusOf(['sable', 'neige', 'guitare', 'violon'])).toBe(0);
    // They are still COUNTED — the post-mortem board draws them, and they never repeat.
    expect(run.counted.map((g) => g.judged.kind)).toEqual(['near', 'near', 'miss', 'miss']);
  });

  it('a group-level repeat is free: it neither claims nor pays twice', () => {
    // 'tropical' repeats the claimed 'tropicales' group; 'sables' repeats the counted
    // near miss 'sable'.
    const run = replayWordRun(RANKS, ['tropicales', 'tropical', 'sable', 'sables']);
    expect(run.claimed.map((e) => e.rank)).toEqual([1]);
    expect(bonusOf(['tropicales', 'tropical', 'sable', 'sables'])).toBe(RARITY_LADDER[0].seconds);
    expect(run.counted).toHaveLength(2);
  });

  it('the day\'s word is free and skipped in the log', () => {
    const run = replayWordRun(RANKS, ['tropiques', 'cocotier']);
    expect(run.claimed.map((e) => e.rank)).toEqual([2]);
    expect(run.counted.map((g) => g.typed)).toEqual(['cocotier']);
  });

  it('nothing in the log ends the run — that is the deadline\'s to say', () => {
    // Whatever the log holds, the walk keeps walking: the clock is wall-clock, so a
    // replay cannot know when time ran out (the round state does).
    const run = replayWordRun(RANKS, ['sable', 'neige', 'guitare', 'violon', 'tropicales']);
    expect(run.claimed.map((e) => e.rank)).toEqual([1]); // the late claim happened
    expect(run).not.toHaveProperty('ended');
  });
});

// The gate STATES the zone (user-decided 2026-08-11). The rule and the sentence that
// announces it must not drift, so the copy carries a `{n}` placeholder and the screen
// fills it from CLAIM_ZONE — a hardcoded number would go quietly wrong the first time the
// zone moves, and a gate that lies about the field is worse than one that says nothing.
describe('the gate names the claimable zone, in both languages', () => {
  it('fills the count from CLAIM_ZONE rather than spelling it into the copy', () => {
    for (const lang of ['en', 'fr']) {
      const raw = t(lang, 'wordRulesGoal');
      expect(raw, `${lang} must keep the placeholder`).toContain('{n}');
      const shown = tn(lang, 'wordRulesGoal', CLAIM_ZONE);
      expect(shown).toContain(String(CLAIM_ZONE));
      expect(shown).not.toContain('{n}');
    }
  });

  it('states the ZONE and nothing else — the timer already shows the seconds', () => {
    for (const lang of ['en', 'fr']) {
      const rules = [tn(lang, 'wordRulesGoal', CLAIM_ZONE), t(lang, 'wordRulesBonus')].join(' ');
      // EXACTLY one number on the whole gate, and it is the zone's — which is also what
      // proves the run's length is not stated here (START_SECONDS is the HUD's to show).
      expect(rules.match(/\d+/g), lang).toEqual([String(CLAIM_ZONE)]);
    }
  });
});
