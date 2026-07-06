// CONTRACT: the onboarding scripts (#51). The tutorial is data-driven — the boards,
// ranks and guesses live in scripts/<lang>.ts and are meant to be edited — so these
// tests guard what an edit must not break:
//
//   Stage 1 (single word, concept first):
//     - the scramble ladder exists: real neighbors at ranks 1..5 (the slow steps) and
//       enough real entries up to start_rank for the fast roll, landing exactly on the
//       start word — the demo IS the explanation of where start words come from;
//     - the gated guesses keep their meanings: the "far" word ranks FARTHER than the
//       start (shows a distance, changes nothing), the "miss" word is absent from the
//       map (MISS, not INVALID), the "closer" word ranks CLOSER (the word moves), and
//       the find target is the secret itself (rank 0).
//   Stage 2 (unguided sentence):
//     - two holes, and the maps are stocked for DISCOVERY: several plausible context
//       words appear in BOTH maps, so the likely first guess lands on both holes.
//
// Plus, for every stage: the dummy puzzle stays byte-compatible with the real
// per-puzzle schema (parsePuzzle-valid — it feeds the REAL game components), scripted
// words are fold-stable slugs the gated keyboard can type, and rank-map padding stays
// unreachable.

import { describe, it, expect } from 'vitest';
import { fold } from '@whippin/shared';
import { parsePuzzle } from '../api';
import { scriptFor } from './scripts';
import { isPadWord, type TutorialStep } from './script';

const MIN_ROLL_WORDS = 8; // real ladder entries the fast rolls can flash
const MIN_SHARED_CONTEXT = 5; // stage-2 words present in BOTH holes' maps

for (const lang of ['en', 'fr'] as const) {
  describe(`tutorial script (${lang})`, () => {
    const script = scriptFor(lang);
    const [wordStage, sentenceStage] = script.stages;

    it('has the two-stage shape: single-word concept stage, then unguided sentence', () => {
      expect(script.stages).toHaveLength(2);
      expect(wordStage.puzzle.holes).toHaveLength(1);
      expect(wordStage.steps[0].kind).toBe('mix');
      expect(wordStage.steps.at(-1)?.kind).toBe('find');
      expect(sentenceStage.puzzle.holes).toHaveLength(2);
      expect(sentenceStage.steps.some((s) => s.kind === 'play')).toBe(true);
    });

    it('every stage puzzle passes the real schema check (parsePuzzle)', () => {
      for (const stage of script.stages) {
        expect(() => parsePuzzle(JSON.parse(JSON.stringify(stage.puzzle)))).not.toThrow();
      }
    });

    it('every scripted word is a fold-stable slug the gated keyboard can produce', () => {
      for (const stage of script.stages) {
        for (const s of stage.steps) {
          if (s.kind === 'guess') expect(fold(s.expect)).toBe(s.expect);
          if (s.kind === 'find') expect(fold(s.target)).toBe(s.target);
        }
      }
    });

    it('rank-map padding is inert — no unreachable key outside the _pad pattern', () => {
      for (const stage of script.stages) {
        for (const map of Object.values(stage.puzzle.ranks)) {
          for (const key of Object.keys(map)) {
            // A player's input is always fold(raw); a key fold can't produce must be a pad.
            if (fold(key) !== key) expect(key).toMatch(/^_pad\d+$/);
          }
        }
      }
    });

    describe('stage 1 — the mix ladder and the guided arc', () => {
      const hole = wordStage.puzzle.holes[0];
      const map = wordStage.puzzle.ranks[hole.secret.slug];
      const real = Object.values(map).filter((e) => !isPadWord(e.word));
      const mix = wordStage.steps[0];
      if (mix.kind !== 'mix') throw new Error('stage 1 must open with the mix demo');

      it('every mix stop lands on a real word, with enough real words to roll through', () => {
        for (const stop of mix.stops) {
          expect(real.some((e) => e.rank === stop.rank)).toBe(true);
        }
        // Stops walk outward, so each press animates forward, never backward.
        const ranks = mix.stops.map((s) => s.rank);
        expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
        const rollable = real.filter((e) => e.rank > 0 && e.rank <= hole.start_rank);
        expect(rollable.length).toBeGreaterThanOrEqual(MIN_ROLL_WORDS);
      });

      it('the last stop IS the start word — the demo explains where start words come from', () => {
        expect(mix.stops.at(-1)?.rank).toBe(hole.start_rank);
        expect(map[hole.start.slug]).toEqual({ word: hole.start.word, rank: hole.start_rank });
        // Nothing real sits between the landing and the start rank besides the
        // far-guess demo entry, so the final roll's landing IS the maximum.
        const within = real.filter((e) => e.rank > 0 && e.rank <= hole.start_rank);
        expect(Math.max(...within.map((e) => e.rank))).toBe(hole.start_rank);
      });

      it('keeps the guided guesses meaningful: farther / absent / closer / the secret', () => {
        const guesses = wordStage.steps.filter(
          (s): s is Extract<TutorialStep, { kind: 'guess' }> => s.kind === 'guess',
        );
        expect(guesses).toHaveLength(3);
        const [far, miss, closer] = guesses;
        expect(map[far.expect]!.rank).toBeGreaterThan(hole.start_rank); // shows a distance, no move
        expect(map[miss.expect]).toBeUndefined(); // MISS, not INVALID
        expect(map[closer.expect]!.rank).toBeLessThan(hole.start_rank); // the word moves
        const find = wordStage.steps.at(-1)!;
        if (find.kind !== 'find') throw new Error('last stage-1 step must be find');
        expect(find.target).toBe(hole.secret.slug);
        expect(map[find.target]!.rank).toBe(0);
      });
    });

    describe('stage 2 — stocked for discovering multi-hole broadcast', () => {
      const [h1, h2] = sentenceStage.puzzle.holes;
      const m1 = sentenceStage.puzzle.ranks[h1.secret.slug];
      const m2 = sentenceStage.puzzle.ranks[h2.secret.slug];

      it('both secrets solve and both start words are in their maps at start_rank', () => {
        expect(m1[h1.secret.slug]!.rank).toBe(0);
        expect(m2[h2.secret.slug]!.rank).toBe(0);
        expect(m1[h1.start.slug]!.rank).toBe(h1.start_rank);
        expect(m2[h2.start.slug]!.rank).toBe(h2.start_rank);
      });

      it('several plausible context words land on BOTH holes (the discovery moment)', () => {
        const shared = Object.keys(m1).filter(
          (k) =>
            !isPadWord(k) &&
            k in m2 &&
            k !== h1.secret.slug &&
            k !== h2.secret.slug &&
            m1[k]!.rank > 0 &&
            m2[k]!.rank > 0,
        );
        expect(shared.length).toBeGreaterThanOrEqual(MIN_SHARED_CONTEXT);
      });

      it('each secret is also a warm word for the OTHER hole (solving one nudges the other)', () => {
        expect(m1[h2.secret.slug]!.rank).toBeGreaterThan(0);
        expect(m2[h1.secret.slug]!.rank).toBeGreaterThan(0);
      });
    });
  });
}
