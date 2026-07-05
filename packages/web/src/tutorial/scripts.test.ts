// CONTRACT: the onboarding scripts (#51). The tutorial is data-driven — the dummy
// sentence, ranks and guesses live in scripts/<lang>.ts and are meant to be edited —
// so these tests guard what an edit must not break:
//
//   1. the dummy puzzle stays byte-compatible with the real per-puzzle schema
//      (parsePuzzle-valid), since it feeds the REAL game components;
//   2. every scripted guess is a fold-stable slug (what the gated keyboard can type);
//   3. replaying the guesses against the script's own rank maps produces the intended
//      LESSON SEQUENCE — the pedagogy, not the numbers:
//        A: MISS on every hole        (every guess is tested on every hole)
//        B: improves BOTH holes       (context, not synonyms)
//        C: solves one; warm-but-no-improve on the other (locking + best-guess-kept)
//        D: the remaining hole solves (solved holes stay silent)
//      An edited script that no longer teaches this fails here, not in production.

import { describe, it, expect } from 'vitest';
import { fold } from '@whippin/shared';
import { parsePuzzle } from '../api';
import { scriptFor } from './scripts';

// A hole's reaction to one guess, by the same rule as the live game loop.
type Outcome = 'locked' | 'miss' | 'improved' | 'solved' | 'warm-no-improve';

function replay(lang: string): Outcome[][] {
  const script = scriptFor(lang);
  const holes = script.puzzle.holes.map((h) => ({ secret: h.secret.slug, rank: h.start_rank }));
  const guesses = script.steps.filter((s) => s.kind === 'guess');
  return guesses.map((g) =>
    holes.map((h): Outcome => {
      if (h.rank === 0) return 'locked';
      const entry = script.puzzle.ranks[h.secret][g.expect];
      if (!entry) return 'miss';
      if (entry.rank >= h.rank) return 'warm-no-improve';
      h.rank = entry.rank;
      return entry.rank === 0 ? 'solved' : 'improved';
    }),
  );
}

for (const lang of ['en', 'fr'] as const) {
  describe(`tutorial script (${lang})`, () => {
    const script = scriptFor(lang);
    const guesses = script.steps.filter((s) => s.kind === 'guess');

    it('dummy puzzle passes the real schema check (parsePuzzle)', () => {
      // Through JSON like a fetched puzzle would be.
      expect(() => parsePuzzle(JSON.parse(JSON.stringify(script.puzzle)))).not.toThrow();
    });

    it('every expected guess is a fold-stable slug the gated keyboard can produce', () => {
      for (const g of guesses) {
        expect(fold(g.expect)).toBe(g.expect);
      }
    });

    it('replays to the intended lesson sequence and ends solved', () => {
      expect(replay(lang)).toEqual([
        ['miss', 'miss'],
        ['improved', 'improved'],
        ['solved', 'warm-no-improve'],
        ['locked', 'solved'],
      ]);
    });

    it('rank-map padding is inert — no pad key is a producible slug', () => {
      for (const map of Object.values(script.puzzle.ranks)) {
        for (const key of Object.keys(map)) {
          // A player's input is always fold(raw); a key fold can't produce is unreachable.
          if (fold(key) !== key) expect(key).toMatch(/^_pad\d+$/);
        }
      }
    });
  });
}
