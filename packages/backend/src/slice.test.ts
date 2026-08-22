// CONTRACT (#203): the DERIVATION SLICE is the small part of a sentence puzzle the server
// needs to say what a stored guess log has reached.
//
//   - it holds, per SECRET, only the keys ranked at or below that hole's `start_rank`
//     (a hole's rank only ever improves from there, so nothing farther can move the
//     percentage or solve anything), plus `n` — the count of distinct ranked GROUPS in
//     the WHOLE map, since that is the progress formula's base and not a key count;
//   - duplicate sentence occurrences of one secret are ONE entry: they share a map, a
//     start hint and a logical progress target;
//   - `deriveRound` reads a log against it with the shared progress math, so the number
//     the server stores is the number the web draws;
//   - it travels GZIPPED, through one codec, and a wrong-shaped one is refused at parse
//     rather than deriving a silent 0%.

import { describe, expect, it } from 'vitest';
import { holeProgress, type Puzzle } from '@whippin/shared';
import { buildSlice, decodeSlice, deriveRound, encodeSlice, parseSlice } from './slice';

// Two holes; the second is a REPEATED occurrence of the first secret, so the slice must
// collapse them. `phare`'s map carries an alias (two keys at rank 1) and one group beyond
// the start rank, which the slice must drop.
const PUZZLE: Puzzle = {
  lang: 'fr',
  revision: 'a1b2c3d4e5f60718',
  words: ['le', 'phare', 'du', 'phare', 'de', 'nuit'],
  holes: [
    { pos: 1, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 2 },
    { pos: 3, secret: { word: 'phare', slug: 'phare' }, start: { word: 'quai', slug: 'quai' }, start_rank: 2 },
    { pos: 5, secret: { word: 'nuit', slug: 'nuit' }, start: { word: 'soir', slug: 'soir' }, start_rank: 2 },
  ],
  ranks: {
    phare: {
      phare: { word: 'phare', rank: 0 },
      mer: { word: 'mer', rank: 1, dq: 255 },
      mers: { word: 'mer', rank: 1, dq: 255 }, // an alias: same GROUP, same rank
      quai: { word: 'quai', rank: 2, dq: 128 },
      loin: { word: 'loin', rank: 9, dq: 0 }, // beyond the start — unreachable
    },
    nuit: {
      nuit: { word: 'nuit', rank: 0 },
      lune: { word: 'lune', rank: 1, dq: 255 },
      soir: { word: 'soir', rank: 2, dq: 128 },
      loin: { word: 'loin', rank: 7, dq: 0 },
    },
  },
};

describe('buildSlice — what a puzzle keeps', () => {
  it('keeps only the ranks a hole can still reach, per SECRET', () => {
    const slice = buildSlice(PUZZLE);
    expect(Object.keys(slice.holes).sort()).toEqual(['nuit', 'phare']);
    // Every key at or below the start rank, aliases included; nothing beyond it.
    expect(slice.holes.phare.ranks).toEqual({ phare: 0, mer: 1, mers: 1, quai: 2 });
    expect(slice.holes.nuit.ranks).toEqual({ nuit: 0, lune: 1, soir: 2 });
    expect(slice.holes.phare.startRank).toBe(2);
  });

  it('takes `n` from the WHOLE map as distinct GROUPS, never from the kept keys', () => {
    // `phare` has 5 keys over 4 distinct ranks (0/1/1/2/9) — the slice keeps 4 of those
    // keys, but the log's base is still 4 groups. Reading `n` off the kept keys would
    // inflate every percentage on an aliased puzzle and shrink it on a truncated one.
    expect(buildSlice(PUZZLE).holes.phare.n).toBe(4);
    expect(buildSlice(PUZZLE).holes.nuit.n).toBe(4);
  });

  it('is ONE entry per secret, however many occurrences the sentence has', () => {
    // Three holes, two secrets: the repeated occurrence is not a second progress target.
    expect(PUZZLE.holes).toHaveLength(3);
    expect(Object.keys(buildSlice(PUZZLE).holes)).toHaveLength(2);
  });

  it('refuses a puzzle whose secret has no rank map rather than shipping a blind slice', () => {
    const broken = { ...PUZZLE, ranks: { nuit: PUZZLE.ranks.nuit } };
    expect(() => buildSlice(broken)).toThrow(/phare/);
  });
});

describe('deriveRound — what a stored log has reached', () => {
  const slice = buildSlice(PUZZLE);

  it('is 0% at the start and 100% + solved when every secret is typed', () => {
    expect(deriveRound(slice, [])).toEqual({ progress: 0, solved: false });
    const done = deriveRound(slice, ['phare', 'nuit']);
    expect(done.solved).toBe(true);
    expect(done.progress).toBeCloseTo(100, 10);
  });

  it('averages the holes with the shared progress math, so both ends agree', () => {
    // One hole at rank 1, the other untouched at its start.
    const derived = deriveRound(slice, ['mer']);
    const expected = (100 * (holeProgress(1, 2, 4) + holeProgress(2, 2, 4))) / 2;
    expect(derived.progress).toBeCloseTo(expected, 10);
    expect(derived.solved).toBe(false);
  });

  it('takes the BEST rank a log reached, whatever order it was typed in', () => {
    const forwards = deriveRound(slice, ['quai', 'mer', 'phare']);
    const backwards = deriveRound(slice, ['phare', 'mer', 'quai']);
    expect(forwards).toEqual(backwards);
    // A closer alias counts exactly like its group's own form.
    expect(deriveRound(slice, ['mers'])).toEqual(deriveRound(slice, ['mer']));
  });

  it('ignores what the slice does not hold — a miss, and a guess beyond the start', () => {
    expect(deriveRound(slice, ['loin', 'zzz'])).toEqual({ progress: 0, solved: false });
  });

  it('never reads a guess off the prototype chain', () => {
    // A folded slug is all lowercase letters, so `constructor` is a word a player can
    // genuinely type; a bare index read would answer it with a function.
    expect(deriveRound(slice, ['constructor', 'tostring'])).toEqual({
      progress: 0,
      solved: false,
    });
    // …including on a slice that came back through JSON, whose maps have an ordinary
    // prototype.
    const rehydrated = decodeSlice(encodeSlice(slice));
    expect(deriveRound(rehydrated, ['constructor'])).toEqual({ progress: 0, solved: false });
  });

  it('is solved only when EVERY secret is at rank 0', () => {
    expect(deriveRound(slice, ['phare']).solved).toBe(false);
    expect(deriveRound(slice, ['nuit']).solved).toBe(false);
  });
});

describe('the stored form — one codec, and a refusal for anything else', () => {
  it('round-trips through gzip', () => {
    const slice = buildSlice(PUZZLE);
    const bytes = encodeSlice(slice);
    // Gzip's own magic number: the object IS compressed bytes, so a reader that
    // `transformToString`s it would hand JSON.parse a mangled blob.
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(decodeSlice(bytes)).toEqual(slice);
  });

  it('refuses a wrong-shaped slice rather than deriving a silent 0%', () => {
    expect(() => parseSlice(null)).toThrow(/not an object/);
    expect(() => parseSlice({ holes: {} })).toThrow(/lang/);
    expect(() => parseSlice({ lang: 'fr', revision: 'abc123' })).toThrow(/holes/);
    expect(() =>
      parseSlice({ lang: 'fr', revision: 'abc123', holes: { a: { n: 0, startRank: 1, ranks: {} } } }),
    ).toThrow(/hole entry/);
    expect(() =>
      parseSlice({ lang: 'fr', revision: 'abc123', holes: { a: { n: 4, startRank: -1, ranks: {} } } }),
    ).toThrow(/hole entry/);
  });

  // The artifact has to say WHICH REVISION it describes, or a warm instance keeps deriving
  // the retired sentence's ranks against the corrected round (puzzleCache.ts).
  it('refuses an UNVERSIONED slice — it would derive against whatever version asked', () => {
    expect(() => parseSlice({ lang: 'fr', holes: { a: { n: 4, startRank: 2, ranks: {} } } })).toThrow(
      /revision/,
    );
  });

  it('carries the PUBLISHED VERSION its puzzle was stamped with', () => {
    // The one identity the two objects `publish` writes share, and the one the client sends:
    // it is what stops a solve being derived from one version's slice and scored from
    // another's rank maps.
    expect(buildSlice(PUZZLE).revision).toBe('a1b2c3d4e5f60718');
    expect(buildSlice({ ...PUZZLE, revision: 'b2c3d4e5f6071829' }).revision).toBe('b2c3d4e5f6071829');
  });

  // The two SILENT readings a partial object produces are what the refusal is for, so they
  // are named rather than left to the shape checks above (tightened on review, where the
  // comment promised more than the code did).
  it('refuses an EMPTY holes map — it would answer 0% and never solve, for every log', () => {
    expect(() => parseSlice({ lang: 'fr', revision: 'abc123', holes: {} })).toThrow(/empty/);
  });

  it('refuses a non-numeric or out-of-range rank — it would hide a reachable secret', () => {
    const withRank = (rank: unknown) => ({
      lang: 'fr',
      revision: 'abc123',
      holes: { phare: { n: 4, startRank: 2, ranks: { mer: rank } } },
    });
    // A string compares false against every `best`, so the secret becomes unreachable
    // while everything else looks fine.
    expect(() => parseSlice(withRank('1'))).toThrow(/bad rank/);
    expect(() => parseSlice(withRank(-1))).toThrow(/bad rank/);
    expect(() => parseSlice(withRank(1.5))).toThrow(/bad rank/);
    // And a rank beyond the start cannot move this hole, so it has no business here.
    expect(() => parseSlice(withRank(9))).toThrow(/bad rank/);
    expect(parseSlice(withRank(1))).toBeTruthy();
  });

  it('VALIDATES what it encodes, so a malformed puzzle fails at PUBLISH, not at every append', () => {
    // A day whose slice the reader refuses answers the day-addressed 404 on every append.
    // Failing here puts that in front of a person instead.
    expect(() => encodeSlice({ lang: 'fr', revision: 'abc123', holes: {} })).toThrow(/empty/);
  });
});
