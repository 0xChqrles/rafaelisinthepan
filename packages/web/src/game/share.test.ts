// CONTRACT: the solved-screen share (issue #8, packages/web/src/game/share.ts), asserted
// against the agreed design:
//   - the per-guess progress trajectory (and the solve moments behind the ruler's ticks) are
//     replayed from the ordered guesses;
//   - the result is shared as a link `<origin>/s/<token>` that the backend unfurls into the
//     card image — the RAW run since the v2 token, so the card draws the same ruler as the
//     solved screen (the codec itself is contract-tested in @whippin/shared);
//   - the plain-text emoji row is a BOUNDED summary of that ruler: 3..18 cells on a hardcoded
//     breakpoint curve (more tries -> more cells), each the MEAN progress of its bucket —
//     except the last, pinned to the solving try so a finished run always ends where it ended.

import { describe, it, expect } from 'vitest';
import {
  replayRun,
  emojiRow,
  rowCellCount,
  rowMeans,
  shareHeadline,
  shareText,
  shareUrl,
  rarityRow,
  wordShareText,
  wordShareUrl,
  RARITY_EMOJI,
  MIN_ROW_CELLS,
  MAX_ROW_CELLS,
  ROW_BREAKPOINTS,
} from './share';
import { computeProgress, guessKey } from './scoring';
import { RARITY_NAMES } from './wordGame';
import {
  dayNumber,
  decodeResult,
  decodeWordResult,
  progressEmoji,
  type RankMap,
  type RuntimeHole,
} from '@whippin/shared';

// Visible glyphs in a row: a colored square is one code point, a keycap is three (digit +
// VS16 + COMBINING ENCLOSING KEYCAP), so dropping the two combining marks counts cells.
function countGlyphs(row: string): number {
  return [...row].filter((c) => c !== '️' && c !== '⃣').length;
}

// A rank map for one secret with N entries -> N keys, `wI` at rank I (so `w0` == solved).
function mk(N: number): RankMap[string] {
  const inner: RankMap[string] = {};
  for (let i = 0; i < N; i++) inner[`w${i}`] = { word: `w${i}`, rank: i };
  return inner;
}
function hole(secret: string, startRank: number): RuntimeHole {
  return { pos: 0, secret, word: secret, rank: startRank, startRank };
}

describe('replayRun().trajectory — replay the ordered guesses', () => {
  const ranks: RankMap = { a: mk(1000) };
  const fresh: RuntimeHole[] = [hole('a', 300)];

  it('has one value per counted guess, monotonic, ending at 100 when solved', () => {
    const t = replayRun(fresh, ranks, ['w200', 'w50', 'w0']).trajectory;
    expect(t).toHaveLength(3);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    expect(t[t.length - 1]).toBeCloseTo(100, 9);
  });

  it('each value equals computeProgress at that hole rank (matches the live loop)', () => {
    const t = replayRun(fresh, ranks, ['w200', 'w50', 'w0']).trajectory;
    expect(t[0]).toBeCloseTo(computeProgress([{ ...fresh[0], rank: 200 }], ranks), 9);
    expect(t[1]).toBeCloseTo(computeProgress([{ ...fresh[0], rank: 50 }], ranks), 9);
  });

  it('a guess worse than the current rank does not regress a hole', () => {
    const t = replayRun(fresh, ranks, ['w50', 'w200']).trajectory;
    expect(t[1]).toBe(t[0]);
  });

  it('a guess absent from a hole map (a MISS for it) leaves that hole untouched', () => {
    const t = replayRun(fresh, ranks, ['zzz']).trajectory;
    expect(t[0]).toBe(0);
  });

  it('advances several holes at once, averaging their progress', () => {
    const two: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), hole('b', 300)];
    const t = replayRun(holes, two, ['w0']).trajectory;
    expect(t[0]).toBeCloseTo(100, 9);
  });

  it('replays a shared secret across duplicate positions and solves both instances', () => {
    const ranks: RankMap = { chat: mk(1000) };
    const holes: RuntimeHole[] = [
      { pos: 1, secret: 'chat', word: 'animal', rank: 300, startRank: 300 },
      { pos: 4, secret: 'chat', word: 'bête', rank: 300, startRank: 300 },
    ];

    const trajectory = replayRun(holes, ranks, ['w200', 'w0']).trajectory;
    expect(trajectory).toHaveLength(2);
    expect(trajectory[0]).toBeGreaterThan(0);
    expect(trajectory[1]).toBeCloseTo(100, 9);
  });
});

describe('replayRun().solvedAt — solve moments per distinct secret, in sentence order', () => {
  it('records the 1-based try that solved each secret, in first-occurrence order', () => {
    // b's map only knows 'bb' (its secret): try 1 misses everything, try 2 solves b,
    // try 4 solves a — so the sentence-order result is [4, 2], not guess order.
    const ranks: RankMap = { a: mk(1000), b: { bb: { word: 'bb', rank: 0 } } };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 200), pos: 3 }];
    expect(replayRun(holes, ranks, ['zzz', 'bb', 'w50', 'w0']).solvedAt).toEqual([4, 2]);
  });

  it('one guess dropping several secrets gives each the SAME try (one shared tick)', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 300), pos: 2 }];
    expect(replayRun(holes, ranks, ['w200', 'w0']).solvedAt).toEqual([2, 2]);
  });

  it('a run that never solves a secret leaves null for it (DNF opponents)', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 300), pos: 2 }];
    expect(replayRun(holes, ranks, ['w200', 'w100']).solvedAt).toEqual([null, null]);
  });

  it('a repeated secret is ONE entry: all its occurrences solve on the same guess', () => {
    const ranks: RankMap = { chat: mk(1000) };
    const holes: RuntimeHole[] = [
      { pos: 1, secret: 'chat', word: 'animal', rank: 300, startRank: 300 },
      { pos: 4, secret: 'chat', word: 'bête', rank: 300, startRank: 300 },
    ];
    expect(replayRun(holes, ranks, ['w200', 'w0']).solvedAt).toEqual([2]);
  });
});

describe('replayRun — the cells and the ticks come out of ONE walk', () => {
  it('puts the last tick on exactly the try whose cell reaches 100', () => {
    // The two halves are only ever drawn together (one bar, its marks). This is the
    // invariant a single walk buys: the guess that completes the reconstruction IS the
    // guess that drops the last secret — they can never name different tries.
    const ranks: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 300), pos: 2 }];
    const { trajectory, solvedAt } = replayRun(holes, ranks, ['w200', 'w0', 'w100']);
    const lastTick = Math.max(...solvedAt.map((at) => at ?? 0));
    expect(trajectory[lastTick - 1]).toBe(100);
    expect(trajectory.slice(0, lastTick - 1).every((p) => p < 100)).toBe(true);
  });

  it('is what the two single-purpose exports return', () => {
    const ranks: RankMap = { a: mk(1000), b: mk(1000) };
    const holes: RuntimeHole[] = [hole('a', 300), { ...hole('b', 300), pos: 2 }];
    const tried = ['w200', 'w50', 'w0'];
    expect(replayRun(holes, ranks, tried)).toEqual({
      trajectory: replayRun(holes, ranks, tried).trajectory,
      solvedAt: replayRun(holes, ranks, tried).solvedAt,
    });
  });

  it('replays the SOLVED board from the counted tries, even across a slug collision', () => {
    // Everything on the solved screen and the shared card is replayed from the counted-try
    // log, so a solve the log cannot reproduce is invisible: no tick, no keycap, a run that
    // stops short of 100. That happened on fr day 20667 because the dedupe identity was read
    // off ONE map, which fused `maniere` and `manieres` (both folding onto `maniérés`) while
    // the hole's own map ranks them 2 and 0. Same shape here, played in that order.
    const ranks: RankMap = {
      tropiques: {
        w0: { word: 'tropiques', rank: 0 },
        maniere: { word: 'maniérés', rank: 6783 },
        manieres: { word: 'maniérés', rank: 6783 },
      },
      manieres: {
        maniere: { word: 'manière', rank: 2 },
        manieres: { word: 'manières', rank: 0 },
        w0: { word: 'w0', rank: 900 },
      },
    };
    const holes: RuntimeHole[] = [hole('tropiques', 146), { ...hole('manieres', 126), pos: 5 }];

    // The log the store keeps: guesses deduped by canonical identity, as Game submits them.
    const tried: string[] = [];
    for (const typed of ['maniere', 'manieres', 'w0']) {
      if (!tried.some((prev) => guessKey(ranks, prev) === guessKey(ranks, typed))) tried.push(typed);
    }
    expect(tried).toEqual(['maniere', 'manieres', 'w0']); // the solving plural is kept

    const { trajectory, solvedAt } = replayRun(holes, ranks, tried);
    expect(solvedAt).not.toContain(null); // every secret has its tick
    expect(trajectory[trajectory.length - 1]).toBeCloseTo(100, 9);
  });
});

describe('rowCellCount — the hardcoded breakpoint curve, 3..18', () => {
  it('is the minimum 3 for a perfect game (3 secrets -> 3 distinct words)', () => {
    expect(rowCellCount(3)).toBe(3);
    expect(MIN_ROW_CELLS).toBe(3);
  });

  it('adds one cell at each breakpoint (half-open, tries >= t)', () => {
    expect(rowCellCount(4)).toBe(4);
    expect(rowCellCount(5)).toBe(4);
    expect(rowCellCount(6)).toBe(5);
    expect(rowCellCount(9)).toBe(5);
    expect(rowCellCount(10)).toBe(6);
    expect(rowCellCount(62)).toBe(10);
    expect(rowCellCount(99)).toBe(11);
    expect(rowCellCount(100)).toBe(12);
    expect(rowCellCount(299)).toBe(17);
    expect(rowCellCount(300)).toBe(18);
  });

  it('CAPS at 18 no matter how long the game runs — the whole point of the bound', () => {
    expect(MAX_ROW_CELLS).toBe(18);
    expect(MAX_ROW_CELLS).toBe(MIN_ROW_CELLS + ROW_BREAKPOINTS.length);
    expect(rowCellCount(300)).toBe(MAX_ROW_CELLS);
    expect(rowCellCount(5000)).toBe(MAX_ROW_CELLS);
    expect(rowCellCount(Number.MAX_SAFE_INTEGER)).toBe(MAX_ROW_CELLS);
  });

  it('is monotonic non-decreasing in tries', () => {
    for (let t = 3; t < 400; t++) expect(rowCellCount(t + 1)).toBeGreaterThanOrEqual(rowCellCount(t));
  });
});

describe('rowMeans — the trajectory collapsed into rowCellCount buckets', () => {
  it('returns rowCellCount(n) values, each within the data range', () => {
    const traj = Array.from({ length: 20 }, (_, i) => (100 * (i + 1)) / 20); // 5,10,...,100
    const cells = rowMeans(traj);
    expect(cells).toHaveLength(rowCellCount(20)); // 7
    for (const v of cells) {
      expect(v).toBeGreaterThanOrEqual(traj[0]);
      expect(v).toBeLessThanOrEqual(traj[traj.length - 1]);
    }
  });

  it('is monotonic non-decreasing (progress is, and the buckets are contiguous)', () => {
    const traj = Array.from({ length: 137 }, (_, i) => (100 * (i + 1)) / 137);
    const cells = rowMeans(traj);
    expect(cells).toHaveLength(rowCellCount(137)); // 13
    for (let i = 1; i < cells.length; i++) expect(cells[i]).toBeGreaterThanOrEqual(cells[i - 1]);
  });

  it('averages WITHIN a bucket (it samples nothing)', () => {
    // 6 guesses -> 5 cells: with floor(i*n/m) boundaries the last bucket holds [50,60]; its
    // mean would be 55, but the LAST cell is pinned to the final try (60) — see below.
    expect(rowMeans([10, 20, 30, 40, 50, 60])).toEqual([10, 20, 30, 40, 60]);
    // A mid-row bucket really is a mean: 8 guesses -> 5 cells with boundaries 0,1,3,4,6,8,
    // so cell 1 holds guesses 2-3 and shows their mean, while the last (guesses 7-8, mean
    // 85) is overridden by the pin.
    const cells = rowMeans([0, 50, 60, 60, 70, 70, 80, 90]);
    expect(cells[1]).toBe(55);
    expect(cells[cells.length - 1]).toBe(90);
  });

  it('PINS the last cell to the solving try, never its bucket mean', () => {
    // The reason the bounded row was briefly retired: a 61-try grind plateaus at 70 and
    // solves on its last guess, so the final bucket's MEAN is ~74 and the row closed on
    // the drained 🟪 — a finished game that reads unfinished. The pin makes the last cell
    // the real ending, which on this scale is the calm the solve actually restored.
    const grind = [...Array(60).fill(70), 100];
    const cells = rowMeans(grind);
    expect(cells).toHaveLength(rowCellCount(61)); // 10
    expect(cells[cells.length - 1]).toBe(100);
    expect([...emojiRow(grind)].pop()).toBe('🟦');
  });

  it('handles no guesses without throwing', () => {
    expect(rowMeans([])).toEqual([]);
  });
});

describe('emojiRow — the bounded row in plain text (fallback where no card image renders)', () => {
  // A 62-try grind: 10 cells, secrets dropped on tries 14, 58 and 62.
  const GRIND = Array.from({ length: 62 }, (_, i) =>
    i < 3 ? 12 : i < 8 ? 33 : i < 14 ? 48 : i < 58 ? 61 : i < 61 ? 78 : 100,
  );

  it('walks the same WEIRD→CALM scale as the ruler, not a second palette', () => {
    // 3 tries -> 3 cells, so this row is one emoji per try and each band shows plainly. The
    // bands themselves are contract-tested against the ramp in @whippin/shared.
    expect(emojiRow([5, 40, 90])).toBe('🟥🟨🟦');
    expect(emojiRow([5, 40, 90])).toBe([5, 40, 90].map(progressEmoji).join(''));
  });

  it('ends on the ramp top when there are no solve moments to mark', () => {
    expect([...emojiRow([100])].pop()).toBe('🟦');
    expect([...emojiRow([0])].pop()).toBe('🟥');
  });

  it('replaces a solving cell with that hole SENTENCE-POSITION keycap', () => {
    // The row carries the ruler's ticks: the cell holding the try that dropped a secret
    // shows the hole's number instead of its ramp color, so the row tells the ORDER the
    // sentence was cracked, not just how the reconstruction moved.
    expect(emojiRow(GRIND, [14, 58, 62])).toBe('🟨🟨1️⃣🟪🟪🟪🟪🟪🟪2️⃣3️⃣');
    // The digit is the hole's position in the SENTENCE, not the order it fell — the same
    // run with the solves reversed puts 3️⃣ where 1️⃣ was.
    expect(emojiRow(GRIND, [62, 58, 14])).toBe('🟨🟨3️⃣🟪🟪🟪🟪🟪🟪1️⃣2️⃣');
  });

  it('keeps EVERY keycap when several secrets fall inside one cell', () => {
    // A perfect game is 3 cells and 3 solves — every cell is a keycap and no color is left,
    // which is the point: the row says "straight down the sentence, no misses".
    expect(emojiRow([33, 67, 100], [1, 2, 3])).toBe('1️⃣2️⃣3️⃣');
    // 5 tries -> 4 cells: the last cell holds tries 4 AND 5, so it shows both keycaps in
    // sentence order (the same order the ruler stacks them under one shared tick).
    expect(emojiRow([20, 40, 55, 70, 100], [3, 5, 4])).toBe('🟨🟨1️⃣2️⃣3️⃣');
  });

  it('marks nothing for a secret the run never solved', () => {
    expect(emojiRow(GRIND, [14, null, null])).toContain('1️⃣');
    expect(emojiRow(GRIND, [14, null, null])).not.toContain('2️⃣');
    expect(emojiRow(GRIND, [null, null, null])).toBe(emojiRow(GRIND));
  });

  it('ALWAYS ends on a keycap once the run is solved (the last try is a solve)', () => {
    for (const [traj, solved] of [
      [[33, 67, 100], [1, 2, 3]],
      [[20, 40, 55, 70, 100], [3, 5, 4]],
      [GRIND, [14, 58, 62]],
    ] as [number[], number[]][]) {
      // A keycap is digit + VS16 + enclosing mark, so the row ENDS with that 3-code-point
      // sequence — the last code point alone is the combining mark.
      expect(emojiRow(traj, solved)).toMatch(/[1-3]️⃣$/u);
    }
  });

  it('stays bounded: 18 cells, and at most two extra glyphs from a shared cell', () => {
    for (const n of [19, 62, 137, 300, 1000]) {
      const traj = Array.from({ length: n }, (_, i) => (100 * (i + 1)) / n);
      const plain = [...emojiRow(traj)]; // spread: each colored square is ONE code point
      expect(plain.length).toBeLessThanOrEqual(MAX_ROW_CELLS);
      expect(plain).toHaveLength(rowCellCount(n));
      // Worst case for the marked row: all three secrets dropped by the same guess, so one
      // cell carries three keycaps and the row runs two glyphs long.
      const marked = emojiRow(traj, [n, n, n]);
      expect(countGlyphs(marked)).toBeLessThanOrEqual(MAX_ROW_CELLS + 2);
    }
    // A 62-try game is 11 glyphs, not 62: 10 cells, with the last one carrying the two
    // secrets that fell inside it.
    expect(countGlyphs(emojiRow(GRIND, [14, 58, 62]))).toBe(11);
    expect(countGlyphs(emojiRow(GRIND))).toBe(10);
  });

  it('handles no guesses without throwing', () => {
    expect(emojiRow([])).toBe('');
    expect(emojiRow([], [1, 2, 3])).toBe('');
  });
});

describe('shareHeadline — ONE line shape for both dailies', () => {
  it('names the day by its CALENDAR DATE, never the internal index', () => {
    const day = dayNumber('2026-08-11');
    expect(shareHeadline(day, 12, 'mots')).toBe('Whippin AI 2026-08-11 — 12 mots');
    // The index says nothing to a reader, and the archive URL the link resolves to spells
    // the date — so the message has to spell it too.
    expect(shareHeadline(day, 12, 'mots')).not.toContain(String(day));
  });

  it('gives the two modes the same line, differing only in the unit each localizes', () => {
    const day = dayNumber('2026-08-11');
    const sentence = shareHeadline(day, 3, 'essais');
    const word = shareHeadline(day, 3, 'mots');
    expect(sentence.replace('essais', '')).toBe(word.replace('mots', ''));
  });
});

describe('shareText — headline, emoji ruler, blank line, URL in order', () => {
  it('composes the four parts on the agreed lines', () => {
    const text = shareText('Whippin #12 — 3 tries', [10, 50, 90], [1, 2, 3], 'https://whippin.ai/s/tok');
    expect(text).toBe('Whippin #12 — 3 tries\n1️⃣2️⃣3️⃣\n\nhttps://whippin.ai/s/tok');
  });

  it('keeps the row attached to the headline and a blank line before the (unfurling) URL', () => {
    const headline = 'Whippin #7 — 3 tries';
    const url = 'https://whippin.ai/s/abc';
    const trajectory = [40, 70, 100];
    const solvedAt = [2, 1, 3];
    const lines = shareText(headline, trajectory, solvedAt, url).split('\n');
    expect(lines[0]).toBe(headline); // headline first
    expect(lines[1]).toBe(emojiRow(trajectory, solvedAt)); // row on its own line, under it
    expect(lines[2]).toBe(''); // blank line preserves the OG-unfurl separation
    expect(lines[3]).toBe(url); // link last
  });

  it('keeps the row short even when the headline count is large', () => {
    // The headline carries the exact score; the row is a bounded picture of how it went, so
    // a long game stays pasteable instead of wrapping across a phone screen.
    const trajectory = Array.from({ length: 137 }, (_, i) => (100 * (i + 1)) / 137);
    const lines = shareText('Whippin #7 — 137 tries', trajectory, [40, 96, 137], 'https://x/y').split('\n');
    expect(countGlyphs(lines[1])).toBeLessThanOrEqual(MAX_ROW_CELLS + 2);
    expect(countGlyphs(lines[1])).toBe(rowCellCount(137)); // three solves, three distinct cells
  });
});

describe('shareUrl — result packed into a /s/<token> link', () => {
  // A real dayNumber (days since 1970 ≈ 20638 today) and a 3-try perfect game: the token
  // carries the RAW run + its solve moments, so the card draws the same ruler as the screen.
  const result = {
    lang: 'fr',
    dayNumber: 20638,
    score: 3,
    trajectory: [40, 70, 100],
    solvedAt: [1, 2, 3],
  };

  it('builds <origin>/s/<token> and the token round-trips the result', () => {
    const url = shareUrl('https://whippin.ai', result);
    expect(url.startsWith('https://whippin.ai/s/')).toBe(true);
    const decoded = decodeResult(url.slice('https://whippin.ai/s/'.length));
    expect(decoded?.lang).toBe('fr');
    expect(decoded?.dayNumber).toBe(20638);
    expect(decoded?.score).toBe(3);
    expect(decoded?.trajectory).toHaveLength(3); // one ruler cell per counted try
    expect(decoded?.solvedAt).toEqual([1, 2, 3]); // one ruler tick per secret
  });

  it('carries no spoilers — the sentence/words never appear in the link', () => {
    const url = shareUrl('https://whippin.ai', result);
    // Only the origin, the /s/ path, and a base64url token.
    expect(url).toMatch(/^https:\/\/whippin\.ai\/s\/[A-Za-z0-9_-]+$/);
  });
});

// CONTRACT: Word mode's share (#156; the rarity breakdown 2026-08-11). The plain text is
// the app's visit card, so its exact shape is asserted here rather than left to the
// component: the headline, a blank line, the RESULT BLOCK (the day's word in locale-aware
// uppercase with its bead row directly under it), a blank line, the link.
describe('rarityRow — the breakdown as one line of beads', () => {
  it('has exactly one bead per grade, and no two grades share one', () => {
    expect(Object.keys(RARITY_EMOJI).sort()).toEqual([...RARITY_NAMES].sort());
    // Two grades wearing one bead would make the row unreadable in the one place it has no
    // colour key beside it — a message.
    expect(new Set(RARITY_NAMES.map((n) => RARITY_EMOJI[n])).size).toBe(RARITY_NAMES.length);
  });

  it('reads commonest-first and omits the grades the run never claimed', () => {
    expect(rarityRow([7, 3, 1, 1, 0])).toBe('⚪7 🟢3 🔵1 🟣1');
    // A deep run opens on cyan — the SHAPE of the line is the shape of the hand.
    expect(rarityRow([0, 0, 3, 4, 2])).toBe('🔵3 🟣4 🩷2');
    expect(rarityRow([0, 0, 0, 0, 0])).toBe(''); // a scoreless run says nothing
  });
});

describe('wordShareText — the message a word run leaves', () => {
  const url = 'https://whippin.ai/s/TOKEN';
  const headline = 'Whippin AI 2026-08-11 — 12 mots';

  it('stacks headline / word + beads / link, blank-line separated', () => {
    expect(wordShareText(headline, 'forêt', 'fr', [7, 3, 1, 1, 0], url)).toBe(
      `${headline}\n\nFORÊT\n⚪7 🟢3 🔵1 🟣1\n\n${url}`,
    );
  });

  it('uppercases the DISPLAY form by locale and never a slug (accents survive)', () => {
    const text = wordShareText(headline, 'crépuscule', 'fr', [0, 0, 3, 4, 2], url);
    expect(text).toContain('CRÉPUSCULE');
    expect(text).not.toContain('crepuscule');
    expect(text).not.toContain('CREPUSCULE');
  });

  it('carries no leading emoji on the word (the 🟦 was dropped 2026-08-11)', () => {
    expect(wordShareText(headline, 'forêt', 'fr', [7, 0, 0, 0, 0], url)).not.toContain('🟦');
  });

  it('drops the bead LINE entirely on a scoreless run, never an empty one', () => {
    const text = wordShareText(headline, 'ocean', 'en', [0, 0, 0, 0, 0], url);
    expect(text).toBe(`${headline}\n\nOCEAN\n\n${url}`);
    expect(text).not.toMatch(/\n\n\n/); // no hole where the row would have been
  });
});

describe('wordShareUrl — the word result as a link', () => {
  const result = { lang: 'fr', dayNumber: 20638, counts: [7, 3, 1, 1, 0], word: 'forêt' };

  it('builds <origin>/s/<token> and the token round-trips the breakdown', () => {
    const url = wordShareUrl('https://whippin.ai', result);
    expect(url).toMatch(/^https:\/\/whippin\.ai\/s\/[A-Za-z0-9_-]+$/);
    expect(decodeWordResult(url.slice('https://whippin.ai/s/'.length))).toEqual(result);
  });
});
