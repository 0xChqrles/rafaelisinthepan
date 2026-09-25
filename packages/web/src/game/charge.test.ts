// CONTRACT (#301, user-decided 2026-09-15; the activation user-decided 2026-09-22): every
// counted guess charges every unsolved hole by its rank in that secret's map, best word or
// not; the meter caps at 100 and a full meter ACTIVATES the hole — every word it holds
// opens the nearest word farther than it the player does not have, GIVEN of them at once,
// nearest the secret first (user-decided 2026-09-25); a mask guessed (typed or revealed)
// is a hint CONSUMED and stays given; rank 0 is the solve and pays nothing;
// repeated occurrences of one secret share one meter; charge is DERIVED from the play log,
// so a replay reconstructs it exactly.

import { describe, expect, it } from 'vitest';
import type { RankMap, RuntimeHole } from '@whippin/shared';
import { CHARGE_TARGET, GIVEN, chargeForRank, replayCharge, strikeFor } from './charge';
import type { HoleCharge } from './charge';
import { replayHoles } from './scoring';
import { buildHistory } from './history';

// A meter's reading, its charge compared with a float's tolerance: the pay is continuous.
function expectMeter(meter: HoleCharge, charge: number, active: boolean) {
  expect(meter.charge).toBeCloseTo(charge, 9);
  expect(meter.active).toBe(active);
  if (!active) expect(meter.given).toEqual([]);
}

// One secret's map with a key at every rank the tests below name.
function mapAt(secret: string, ranks: number[]): RankMap[string] {
  const inner: RankMap[string] = { [secret]: { word: secret, rank: 0 } };
  for (const r of ranks) inner[`${secret}${r}`] = { word: `${secret}${r}`, rank: r };
  return inner;
}

// The first secret's map holds every rank from 1 to 70 (9 is `bois`, below) — a real map
// has no gaps — and three far ones.
const RANKS: RankMap = {
  honnete: mapAt('honnete', [...Array.from({ length: 70 }, (_, i) => i + 1).filter((r) => r !== 9), 100, 999, 1000, 1001]),
  foret: mapAt('foret', [2, 5, 30, 300]),
};
// A guess both maps know, at different ranks — the multi-hole case.
RANKS.honnete.bois = { word: 'bois', rank: 9 };
RANKS.foret.bois = { word: 'bois', rank: 2 };
// An alias: two surfaces for one group in every map (#104) — the play log counts them
// once, and this module must read the log as given without a second notion of a guess.
RANKS.honnete.sinceres = { ...RANKS.honnete.honnete8 };
RANKS.foret.sinceres = { word: 'sincères', rank: 300 };
RANKS.foret.honnete8 = { word: 'sincères', rank: 300 };

function holes(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'honnete', word: 'honnete50', rank: 50, startRank: 50 },
    { pos: 4, secret: 'foret', word: 'foret30', rank: 30, startRank: 30 },
  ];
}

// The given ranks alone, and the consumed ones.
const ranksOf = (c: HoleCharge) => c.given.map((g) => g.rank);
const consumedOf = (c: HoleCharge) => c.given.filter((g) => g.consumed).map((g) => g.rank);

// Four near guesses that leave the meter just under full, and the fifth that fills it.
const FOUR = ['honnete1', 'honnete5', 'honnete10', 'honnete11'];
const FILLS = 'honnete14';

describe('chargeForRank — a continuous function of the rank', () => {
  it('pays 28 for the nearest word and 1.5 at rank 1000, so a word ranked 999 still pays', () => {
    expect(chargeForRank(1)).toBe(28);
    expect(chargeForRank(1000)).toBe(1.5);
    expect(chargeForRank(999)).toBeGreaterThan(1.5);
  });

  it('falls by the same 2.66 every time the distance doubles, and never rises', () => {
    const doubling = (rank: number) => chargeForRank(rank) - chargeForRank(2 * rank);
    expect(doubling(1)).toBeCloseTo(2.66, 2);
    expect(doubling(7)).toBeCloseTo(doubling(1), 10);
    expect(doubling(250)).toBeCloseTo(doubling(1), 10);
    for (let rank = 1; rank < 1000; rank++) {
      expect(chargeForRank(rank + 1)).toBeLessThan(chargeForRank(rank));
    }
  });

  it('a hole a player is STUCK on activates around 37 tries, on the real mix (2026-09-15)', () => {
    // What the holes a round never solved actually saw, replayed from production rounds: a
    // share of their tries per band of ranks, paid at the band's geometric middle — 70% past
    // 1000 or off the map, which pays nothing.
    const stuck: [number, number, number][] = [
      [0.016, 1, 5], [0.009, 6, 10], [0.015, 11, 20], [0.01, 21, 30], [0.021, 31, 50],
      [0.036, 51, 100], [0.022, 101, 150], [0.032, 151, 250], [0.063, 251, 500],
      [0.074, 501, 1000],
    ];
    const perTry = stuck.reduce(
      (sum, [share, low, high]) => sum + share * chargeForRank(Math.sqrt(low * high)),
      0,
    );
    expect(CHARGE_TARGET / perTry).toBeGreaterThan(34);
    expect(CHARGE_TARGET / perTry).toBeLessThan(40);
  });

  it('a rank past 1000, an absent rank and the solve pay nothing', () => {
    expect(chargeForRank(1001)).toBe(0);
    expect(chargeForRank(undefined)).toBe(0);
    expect(chargeForRank(0)).toBe(0);
  });
});

describe('replayCharge — the meter as the play log describes it', () => {
  it('starts empty, inactive, with nothing given', () => {
    expect(replayCharge(holes(), RANKS, [])).toEqual([
      { charge: 0, active: false, given: [] },
      { charge: 0, active: false, given: [] },
    ]);
  });

  it('a guess that is NOT a new best still charges the hole', () => {
    // The hole shows rank 3; later guesses at 50, 100 and 999 leave the board alone…
    const log = ['honnete3', 'honnete50', 'honnete100', 'honnete999'];
    const board = replayHoles(holes(), RANKS, log);
    expect(board[0].rank).toBe(3);
    // …and each pays the meter by its own rank: ≈ 23.8 + 13.0 + 10.3 + 1.5.
    const pays = chargeForRank(3) + chargeForRank(50) + chargeForRank(100) + chargeForRank(999);
    expectMeter(replayCharge(holes(), RANKS, log)[0], pays, false);
  });

  it('caps at the target and activates the moment it is reached', () => {
    // The three nearest words pay ≈ 28 + 25.3 + 23.8 = 77: never active on their own.
    const nearest = ['honnete1', 'honnete2', 'honnete3'];
    const nearestPay = chargeForRank(1) + chargeForRank(2) + chargeForRank(3);
    expectMeter(replayCharge(holes(), RANKS, nearest)[0], nearestPay, false);
    // Four near guesses, ≈ 28 + 21.8 + 19.2 + 18.8 = 87.8: still not.
    const fourPay = chargeForRank(1) + chargeForRank(5) + chargeForRank(10) + chargeForRank(11);
    expectMeter(replayCharge(holes(), RANKS, FOUR)[0], fourPay, false);
    // + ≈ 17.9 ≥ 100: capped, active.
    const full = replayCharge(holes(), RANKS, [...FOUR, FILLS])[0];
    expect(full.charge).toBe(CHARGE_TARGET);
    expect(full.active).toBe(true);
    // Once full, a further guess that neither moves the hole nor takes a hint changes
    // nothing.
    expect(replayCharge(holes(), RANKS, [...FOUR, FILLS, 'honnete999'])[0]).toEqual(full);
  });

  it('a miss and a rank past 1000 pay nothing', () => {
    expect(replayCharge(holes(), RANKS, ['zzz', 'honnete1001'])[0].charge).toBe(0);
  });

  it('one guess charges several holes, each by its own rank in its own map', () => {
    // `bois` is rank 9 for the first secret (≈ 19.6) and rank 2 for the second (≈ 25.3).
    const [first, second] = replayCharge(holes(), RANKS, ['bois']);
    expectMeter(first, chargeForRank(9), false);
    expectMeter(second, chargeForRank(2), false);
  });

  it('repeated occurrences of one secret share one meter', () => {
    const twice: RuntimeHole[] = [
      ...holes(),
      { pos: 7, secret: 'honnete', word: 'honnete50', rank: 50, startRank: 50 },
    ];
    const meters = replayCharge(twice, RANKS, ['honnete21', 'honnete8']);
    expectMeter(meters[0], chargeForRank(21) + chargeForRank(8), false);
    expect(meters[2]).toEqual(meters[0]);
  });

  it('the exact hit is the solve: it pays nothing, and nothing after it touches the hole', () => {
    expect(replayCharge(holes(), RANKS, ['honnete'])[0]).toEqual({ charge: 0, active: false, given: [] });
    const log = ['honnete3', 'honnete', 'honnete1', 'honnete1'];
    expectMeter(replayCharge(holes(), RANKS, log)[0], chargeForRank(3), false);
    // The other hole is untouched by that secret's solve and keeps charging.
    expectMeter(replayCharge(holes(), RANKS, [...log, 'foret2'])[1], chargeForRank(2), false);
  });

  it('replaying the same log reconstructs the same state', () => {
    const log = ['honnete1', 'bois', 'zzz', 'honnete14', 'foret', 'honnete51', 'honnete3'];
    const once = replayCharge(holes(), RANKS, log);
    expect(replayCharge(holes(), RANKS, [...log])).toEqual(once);
    // Two surfaces of one group (#104) are one identity in the play log; whichever
    // spelling the log kept, the meter reads the same.
    const a = replayCharge(holes(), RANKS, ['honnete8']);
    const b = replayCharge(holes(), RANKS, ['sinceres']);
    expect(a).toEqual(b);
  });
});

// CONTRACT (user-decided 2026-09-25): once the meter is full, every word the hole holds —
// the start, every rank reached, every hint revealed — opens the nearest word farther than
// it that the player does not have, and the hole shows the GIVEN openings nearest the
// secret, recomputed after every guess. "If I found 4 and 6, let's give 5 and 7, and if I
// unlock 7 and find 2, let's give 8 and 3"; "max 5 available words at the same time".
describe('the given words — every word held opens the next one, GIVEN at once', () => {
  it('GIVEN is 5 (user-decided 2026-09-23: lower is safer at first; 2026-09-25: at once)', () => {
    expect(GIVEN).toBe(5);
  });

  it('found 4 and 6 give 5 and 7; revealing 7 gives 8; finding 2 gives 3', () => {
    // 4, 6, 30 … 33 fill the meter on 33; the start (50) is held too. 30 … 33 all open 34.
    const base = [4, 6, 30, 31, 32, 33].map((r) => `honnete${r}`);
    const active = replayCharge(holes(), RANKS, base)[0];
    expect(active.active).toBe(true);
    expect(ranksOf(active)).toEqual([5, 7, 34, 51]);
    // 7 revealed: a hint taken, and it opens 8.
    const unlocked = replayCharge(holes(), RANKS, [...base, 'honnete7'])[0];
    expect(unlocked.given).toEqual([
      { rank: 5, consumed: false },
      { rank: 7, consumed: true },
      { rank: 8, consumed: false },
      { rank: 34, consumed: false },
      { rank: 51, consumed: false },
    ]);
    // 2 found: it opens 3.
    const found = replayCharge(holes(), RANKS, [...base, 'honnete7', 'honnete2'])[0];
    expect(ranksOf(found)).toEqual([3, 5, 7, 8, 34, 51]);
  });

  it('at most GIVEN masks at once: a closer word pushes the farthest mask out, a hint taken stays', () => {
    const log = [4, 6, 30, 31, 32, 33, 7, 2].map((r) => `honnete${r}`);
    // 12 opens 13: six openings, the farthest (51) gives way.
    const pushed = replayCharge(holes(), RANKS, [...log, 'honnete12'])[0];
    expect(ranksOf(pushed)).toEqual([3, 5, 7, 8, 13, 34]);
    expect(pushed.given.filter((g) => !g.consumed)).toHaveLength(GIVEN);
    expect(consumedOf(pushed)).toEqual([7]);
    // 51, no longer masked, typed by hand is just a word the player found.
    expect(consumedOf(replayCharge(holes(), RANKS, [...log, 'honnete12', 'honnete51'])[0])).toEqual([7]);
  });

  it('the guess that fills the meter opens its own word, and a known word is stepped over', () => {
    // FOUR + FILLS: 1, 5, 10, 11, 14 and the start 50 held; 10 opens 12, past the known 11.
    const meter = replayCharge(holes(), RANKS, [...FOUR, FILLS])[0];
    expect(ranksOf(meter)).toEqual([2, 6, 12, 15, 51]);
  });

  it('the words are walked through the ranks the map holds, fewer only when it runs out', () => {
    // A map with gaps: 1 … 5 all open 40, the start (900) opens nothing.
    const sparse: RankMap = { lune: mapAt('lune', [1, 2, 3, 4, 5, 40, 41, 900]) };
    const hole: RuntimeHole[] = [{ pos: 0, secret: 'lune', word: 'lune900', rank: 900, startRank: 900 }];
    const log = [1, 2, 3, 4, 5].map((r) => `lune${r}`);
    expect(ranksOf(replayCharge(hole, sparse, log)[0])).toEqual([40]);
    expect(replayCharge(hole, sparse, [...log, 'lune40'])[0].given).toEqual([
      { rank: 40, consumed: true },
      { rank: 41, consumed: false },
    ]);
    expect(consumedOf(replayCharge(hole, sparse, [...log, 'lune40', 'lune41'])[0])).toEqual([40, 41]);
  });

  it('the visible start is held — never masked, never a hint taken', () => {
    const log = [46, 60, 61, 62, 63, 64, 65, 66, 67].map((r) => `honnete${r}`);
    const meter = replayCharge(holes(), RANKS, log)[0];
    expect(meter.active).toBe(true);
    expect(ranksOf(meter)).toEqual([47, 51, 68]);
    const model = buildHistory({
      rankMap: RANKS.honnete, tried: log, hole: replayHoles(holes(), RANKS, log)[0],
      startRank: 50, secretWord: 'honnête', given: meter.given,
    });
    expect(model.stops.filter((s) => s.masked)).toHaveLength(3);
    expect(model.stops.find((s) => s.start)).toMatchObject({ given: false, masked: false });
    expect(consumedOf(replayCharge(holes(), RANKS, [...log, 'honnete50'])[0])).toEqual([]);
  });

  it('nothing is given before the activation, whatever the hole did', () => {
    expect(replayCharge(holes(), RANKS, ['honnete1', 'honnete2', 'honnete3'])[0].given).toEqual([]);
  });

  it('a hole solved before its meter fills gives nothing, and the solve ends the giving', () => {
    expect(replayCharge(holes(), RANKS, ['honnete5', 'honnete'])[0].given).toEqual([]);
    const active = [...FOUR, FILLS];
    const solved = replayCharge(holes(), RANKS, [...active, 'honnete', 'honnete2'])[0];
    expect(solved.given).toEqual(replayCharge(holes(), RANKS, active)[0].given);
    // A guess after the solve consumes nothing either.
    expect(consumedOf(solved)).toEqual([]);
  });

  it('repeated occurrences share the given words', () => {
    const twice: RuntimeHole[] = [
      ...holes(),
      { pos: 7, secret: 'honnete', word: 'honnete50', rank: 50, startRank: 50 },
    ];
    const meters = replayCharge(twice, RANKS, [...FOUR, FILLS]);
    expect(meters[2]).toEqual(meters[0]);
    expect(ranksOf(meters[0])).toEqual([2, 6, 12, 15, 51]);
    // …and a hint taken is taken on the ONE meter they share.
    const after = replayCharge(twice, RANKS, [...FOUR, FILLS, 'honnete2']);
    expect(consumedOf(after[0])).toEqual([2]);
    expect(after[2]).toEqual(after[0]);
  });
});

describe('the hints — masked until guessed, and a guess is what consumes one', () => {
  it('a mask guessed is CONSUMED and opens the next word; a far guess consumes nothing', () => {
    const active = replayCharge(holes(), RANKS, [...FOUR, FILLS])[0];
    expect(consumedOf(active)).toEqual([]);
    // Rank 2 guessed — typed or revealed, the log cannot tell: a hint taken, and 3 opens.
    const one = replayCharge(holes(), RANKS, [...FOUR, FILLS, 'honnete2'])[0];
    expect(consumedOf(one)).toEqual([2]);
    expect(ranksOf(one)).toEqual([2, 3, 6, 12, 15, 51]);
    // A repeat in the log is impossible (the play log dedups); a far guess consumes nothing.
    expect(consumedOf(replayCharge(holes(), RANKS, [...FOUR, FILLS, 'honnete2', 'honnete999'])[0])).toEqual([2]);
  });
});

// 2026-09-23 (user-decided): "only play the slashing animation when the guess give something,
// either it fills the word, or the guess is closer".
describe('the slash plays only for a guess that gives the hole something', () => {
  it('the exact hit is the ultra, whatever else', () => {
    expect(strikeFor(0, true, 0, 50)).toBe('ultra');
  });

  it('a new guess that charges the meter is cut, closer or not', () => {
    expect(strikeFor(120, true, 4.2, 50)).toBe('slash');
  });

  it('a new guess closer than the best is cut, even on a full meter', () => {
    expect(strikeFor(30, true, 0, 50)).toBe('slash');
  });

  it('a full meter and no closer: no slash — the float alone', () => {
    expect(strikeFor(80, true, 0, 50)).toBeUndefined();
    expect(strikeFor(50, true, 0, 50)).toBeUndefined();
  });

  it('a guess already made never cuts, and neither does a far word', () => {
    expect(strikeFor(30, false, 0, 50)).toBeUndefined();
    expect(strikeFor(undefined, true, 0, 50)).toBeUndefined();
  });
});
