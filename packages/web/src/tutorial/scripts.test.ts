// CONTRACT: the onboarding scripts (#51, re-arced by #155; rarity ending 2026-08-11). The
// tutorial is data-driven — the board and the scripted guesses live in scripts/<lang>.ts
// over a REAL generated neighborhood (scripts/<lang>.word.json, a pruned #154 artifact),
// and both are meant to be edited — so these tests guard what an edit must not break:
//
//   The lesson arc, in order:
//     - the scramble ladder exists: real neighbors at every rank up to the start word, so
//       each roll passes enough of them to read as a journey, landing exactly on the start
//       word — the demo IS the explanation of where start words come from;
//     - the gated guesses keep their meanings: the "far" word ranks FARTHER than the start
//       (shows a distance, changes nothing), the "miss" word is absent from the map (MISS,
//       not INVALID), the "closer" word ranks CLOSER (the word moves), and the find target
//       is the secret itself (rank 0);
//     - it ENDS on the RARITY beats: the tutorial teaches the concepts the modes share
//       (semantic distance, then the five-grade rarity ladder) and nothing mode-specific —
//       each mode's own rules live on that mode's pre-game gate.
//
// Plus: the board stays byte-compatible with the real per-puzzle schema (parsePuzzle-valid —
// it feeds the REAL game components) and every scripted word is a fold-stable slug the gated
// keyboard can type.

import { describe, it, expect } from 'vitest';
import { fold } from '@whippin/shared';
import { parsePuzzle } from '../api';
import { scriptFor } from './scripts';
import type { TutorialStep } from './script';
import { t, type UiKey } from '../i18n';

const MIN_ROLL_WORDS = 9; // real words each fast roll passes through (incl. landing)

for (const lang of ['en', 'fr'] as const) {
  describe(`tutorial script (${lang})`, () => {
    const script = scriptFor(lang);
    const { puzzle } = script;
    const hole = puzzle.holes[0];
    const map = puzzle.ranks[hole.secret.slug];
    // One entry per GROUP: a real map keys every inflection of a group to the same entry.
    const groups = new Map(
      Object.values(map)
        .filter((e) => e.rank > 0)
        .map((e) => [e.rank, e] as const),
    );

    it('is ONE single-word board: mix, guided guesses, find, then the rarity ending', () => {
      expect(puzzle.words).toHaveLength(1);
      expect(puzzle.holes).toHaveLength(1);
      expect(Object.keys(puzzle.ranks)).toEqual([hole.secret.slug]);
      expect(script.steps[0].kind).toBe('mix');
      expect(script.steps.at(-1)?.kind).toBe('rarity');
      // Exactly one of each free step, in this order — the arc is not a set of steps.
      expect(script.steps.map((s) => s.kind)).toEqual([
        'mix',
        'guess',
        'guess',
        'guess',
        'find',
        'rarity',
      ]);
    });

    it('the board passes the real schema check (parsePuzzle)', () => {
      expect(() => parsePuzzle(JSON.parse(JSON.stringify(puzzle)))).not.toThrow();
    });

    it('coach copy naming board words matches the map — hand-written strings over regenerated data', () => {
      // Every copy key a step can put in the coach box.
      const keys = new Set<UiKey>();
      for (const s of script.steps) {
        if (s.kind === 'mix') {
          keys.add(s.copyKey);
          for (const stop of s.stops) if (stop.copyKey) keys.add(stop.copyKey);
        } else if (s.kind === 'guess') keys.add(s.copyKey);
        else if (s.kind === 'find') {
          keys.add(s.copyKey);
          keys.add(s.nudgeKey);
        } else {
          keys.add(s.introCopyKey);
          keys.add(s.ladderCopyKey);
        }
      }
      // [[w:word^rank]] claims a rank the map must still assign to that word, and
      // [[b:word]] claims the secret itself — both go stale silently when the board is
      // regenerated, which is exactly the drift everything else here derives away.
      let claims = 0;
      for (const key of keys) {
        const copy = t(lang, key);
        for (const m of copy.matchAll(/\[\[w:([^^\]]+)\^(\d+)\]\]/g)) {
          expect(map[fold(m[1])]?.rank, `${key}: ${m[0]}`).toBe(Number(m[2]));
          claims += 1;
        }
        for (const m of copy.matchAll(/\[\[b:([^\]]+)\]\]/g)) {
          expect(fold(m[1]), `${key}: ${m[0]}`).toBe(hole.secret.slug);
          claims += 1;
        }
      }
      // The guard must be guarding something: the arc's copy does name board words.
      expect(claims).toBeGreaterThan(0);
    });

    it('every scripted word is a fold-stable slug the gated keyboard can produce', () => {
      for (const s of script.steps) {
        if (s.kind === 'guess') expect(fold(s.expect)).toBe(s.expect);
        if (s.kind === 'find') expect(fold(s.target)).toBe(s.target);
      }
      // The map's own keys are inputs too (the find step types against the real vocabulary
      // and lands on them), so a key fold cannot produce would be unreachable.
      for (const key of Object.keys(map)) expect(fold(key)).toBe(key);
    });

    describe('the mix ladder and the guided arc', () => {
      const mix = script.steps[0];
      if (mix.kind !== 'mix') throw new Error('the board must open with the mix demo');

      it('every mix stop lands on a real word, every roll passes enough words', () => {
        for (const stop of mix.stops) expect(groups.has(stop.rank)).toBe(true);
        // Stops walk outward, so each press animates forward, never backward.
        const ranks = mix.stops.map((s) => s.rank);
        expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
        // Each mix (stop i-1 -> stop i) ticks its exponent through every real rank in
        // between and must pass at least MIN_ROLL_WORDS of them — a hop over 2 ranks reads
        // as a glitch, not a journey.
        for (let i = 1; i < mix.stops.length; i += 1) {
          const passed = [...groups.keys()].filter(
            (rank) => rank > mix.stops[i - 1].rank && rank <= mix.stops[i].rank,
          );
          expect(passed.length).toBeGreaterThanOrEqual(MIN_ROLL_WORDS);
        }
      });

      it('the last stop IS the start word — the demo explains where start words come from', () => {
        expect(mix.stops.at(-1)?.rank).toBe(hole.start_rank);
        expect(map[hole.start.slug].rank).toBe(hole.start_rank);
        expect(map[hole.start.slug].word).toBe(hole.start.word);
        // The departure is inside generation's own start band, so the demo lands where a
        // real round would put the player down.
        expect(hole.start_rank).toBeGreaterThanOrEqual(50);
        expect(hole.start_rank).toBeLessThanOrEqual(150);
      });

      it('keeps the guided guesses meaningful: farther / absent / closer / the secret', () => {
        const guesses = script.steps.filter(
          (s): s is Extract<TutorialStep, { kind: 'guess' }> => s.kind === 'guess',
        );
        expect(guesses).toHaveLength(3);
        const [far, miss, closer] = guesses;
        expect(map[far.expect].rank).toBeGreaterThan(hole.start_rank); // shows a distance, no move
        // …and on a READABLE scale (findings 2026-08-03): the lesson is "farther than your
        // start", the same order of magnitude — désert^1183 read as noise where ^330 reads
        // as a distance.
        expect(map[far.expect].rank).toBeLessThanOrEqual(500);
        expect(map[miss.expect]).toBeUndefined(); // MISS, not INVALID
        expect(map[closer.expect].rank).toBeLessThan(hole.start_rank); // the word moves
        const find = script.steps.at(-2)!;
        if (find.kind !== 'find') throw new Error('the find step must precede the ending');
        expect(find.target).toBe(hole.secret.slug);
        expect(map[find.target].rank).toBe(0);
      });
    });
  });
}
