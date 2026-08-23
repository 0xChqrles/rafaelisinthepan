// CONTRACT: the PLAY LOG (#214) — the pure projection of `server guesses + outbox` every
// client derivation reads, and the outbox's own "what is still owed" rule. Asserts the SPEC
// in the root AGENTS.md, not the implementation: server entries first, first spelling of
// each canonical identity wins, and identity — never a raw string — decides what the server
// already holds.

import { describe, it, expect } from 'vitest';
import type { RankMap } from '@whippin/shared';
import { playLogFor, projectPlayLog, unacknowledged } from './playLog';

// A tiny two-secret puzzle where `prive` and `privees` are ONE ranked group in both maps
// (#104's alias expansion), so the two surfaces share a canonical identity, while `foret`
// and `bois` are distinct everywhere.
const RANKS: RankMap = {
  foret: {
    foret: { word: 'forêt', rank: 0 },
    prive: { word: 'privé', rank: 12 },
    privees: { word: 'privé', rank: 12 },
    bois: { word: 'bois', rank: 3 },
  },
  arbre: {
    arbre: { word: 'arbre', rank: 0 },
    prive: { word: 'privé', rank: 40 },
    privees: { word: 'privé', rank: 40 },
    bois: { word: 'bois', rank: 7 },
  },
};

// The identity used everywhere else in this suite: the folded slug itself, so the
// projection's own ordering rules are readable without a rank map in the way.
const bySlug = (typed: string) => typed;

describe('projectPlayLog', () => {
  it('puts the SERVER log first and the outbox after it, in order', () => {
    expect(projectPlayLog(['a', 'b'], ['c', 'd'], bySlug)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the FIRST occurrence of an identity and drops later ones', () => {
    // The same guess sent, acknowledged, and still sitting in an outbox that has not been
    // settled yet: one try, not two.
    expect(projectPlayLog(['a', 'b'], ['b', 'c'], bySlug)).toEqual(['a', 'b', 'c']);
  });

  it('dedups inside each side too', () => {
    expect(projectPlayLog(['a', 'a'], ['b', 'b'], bySlug)).toEqual(['a', 'b']);
  });

  it('is empty when both sides are', () => {
    expect(projectPlayLog([], [], bySlug)).toEqual([]);
  });

  it('is STABLE: the same inputs always project to the same log', () => {
    const once = projectPlayLog(['b', 'a'], ['c'], bySlug);
    expect(projectPlayLog(['b', 'a'], ['c'], bySlug)).toEqual(once);
  });
});

describe('playLogFor — the canonical identity is the puzzle\'s, not the string', () => {
  it('collapses two SURFACES of one group into one try, keeping the server\'s spelling', () => {
    // Another device stored `prive`; this one typed `privees`. They resolve identically in
    // every map, so the score counts ONE try — and what the board displays is the entry the
    // server already holds.
    expect(playLogFor(RANKS, ['prive'], ['privees'])).toEqual(['prive']);
  });

  it('keeps genuinely different guesses apart', () => {
    expect(playLogFor(RANKS, ['foret'], ['bois', 'prive'])).toEqual(['foret', 'bois', 'prive']);
  });

  it('keeps the LOCAL spelling when the server holds nothing for that identity', () => {
    expect(playLogFor(RANKS, [], ['privees'])).toEqual(['privees']);
  });
});

describe('unacknowledged — what the outbox still owes', () => {
  it('drops everything the server\'s log already represents', () => {
    expect(unacknowledged(['a', 'b', 'c'], ['a', 'b'], bySlug)).toEqual(['c']);
  });

  it('drops by IDENTITY, so another device\'s surface of one group settles ours', () => {
    // The server stored `prive`; our outbox holds `privees`. Re-sending it would append a
    // guess the log already counts as the same try — burning a cap slot on a duplicate the
    // projection then hides.
    const keyOf = (typed: string) => (typed === 'privees' ? 'prive' : typed);
    expect(unacknowledged(['privees', 'bois'], ['prive'], keyOf)).toEqual(['bois']);
  });

  it('keeps the whole outbox when the server holds nothing (a 404 round)', () => {
    expect(unacknowledged(['a', 'b'], [], bySlug)).toEqual(['a', 'b']);
  });

  it('empties an outbox the server has fully caught up with', () => {
    expect(unacknowledged(['a', 'b'], ['a', 'b', 'c'], bySlug)).toEqual([]);
  });

  it('preserves the ORDER of what is left', () => {
    expect(unacknowledged(['a', 'b', 'c', 'd'], ['b'], bySlug)).toEqual(['a', 'c', 'd']);
  });
});
