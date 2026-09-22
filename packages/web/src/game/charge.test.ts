// CONTRACT (#301, user-decided 2026-09-15; the activation user-decided 2026-09-22): every
// counted guess charges every unsolved hole by its rank in that secret's map, best word or
// not; the meter caps at 100 and a full meter ACTIVATES the hole — the GIVEN ranks just
// above its best word are given, and every later improvement of the best gives the
// GIVEN_LATER rank(s) above the new best, the windows accumulating; rank 0 is the solve
// and pays nothing;
// repeated occurrences of one secret share one meter; charge is DERIVED from the play log,
// so a replay reconstructs it exactly.

import { describe, expect, it } from 'vitest';
import type { RankMap, RuntimeHole } from '@whippin/shared';
import { CHARGE_TARGET, GIVEN, GIVEN_LATER, chargeForRank, replayCharge } from './charge';
import type { HoleCharge } from './charge';
import { replayHoles } from './scoring';

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

const RANKS: RankMap = {
  honnete: mapAt('honnete', [1, 2, 3, 5, 8, 10, 11, 14, 21, 50, 51, 52, 53, 54, 55, 56, 57, 58, 100, 999, 1000, 1001]),
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

// The ranks best+1 … best+count.
const above = (best: number, count = GIVEN) => Array.from({ length: count }, (_, i) => best + 1 + i);

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
    // Once full, further near guesses that do not move the hole change nothing.
    expect(replayCharge(holes(), RANKS, [...FOUR, FILLS, 'honnete3'])[0]).toEqual(full);
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

describe('the given words — the window above the best word, from the activation on', () => {
  it('the activation gives the GIVEN ranks above the best word as it then stands', () => {
    // The best after the four is rank 1: the window is 2 … 11.
    expect(replayCharge(holes(), RANKS, [...FOUR, FILLS])[0].given).toEqual(above(1));
  });

  it('a hole nobody has moved gives the window above its start word', () => {
    // Guesses at the start rank and beyond: the meter fills, the hole still shows its
    // start (50), and the window stands above it.
    const log = [50, 51, 52, 53, 54, 55, 56, 57, 58, 100].map((r) => `honnete${r}`);
    const meter = replayCharge(holes(), RANKS, log)[0];
    expect(meter.active).toBe(true);
    expect(replayHoles(holes(), RANKS, log)[0].rank).toBe(50);
    expect(meter.given).toEqual(above(50));
  });

  it('the guess that fills the meter and improves the hole at once gives from the NEW best', () => {
    // Under full at best 5; `honnete1` both fills and moves the hole to 1.
    const log = ['honnete5', 'honnete10', 'honnete11', 'honnete14', 'honnete1'];
    const meter = replayCharge(holes(), RANKS, log)[0];
    expect(meter.active).toBe(true);
    expect(meter.given).toEqual(above(1));
  });

  it('each later improvement gives ONE word above the new best; earlier windows stay', () => {
    // Active at best 10 (window 11 … 20); then the best moves to 3: rank 4 alone joins,
    // then to 1: rank 2 — the union, ascending, without repeats.
    expect(GIVEN_LATER).toBe(1);
    const log = ['honnete50', 'honnete51', 'honnete100', 'honnete21', 'honnete14', 'honnete11', 'honnete10'];
    const before = replayCharge(holes(), RANKS, log)[0];
    expect(before.given).toEqual(above(10));
    const after = replayCharge(holes(), RANKS, [...log, 'honnete3'])[0];
    expect(after.given).toEqual([...above(3, GIVEN_LATER), ...above(10)]);
    expect(replayCharge(holes(), RANKS, [...log, 'honnete3', 'honnete1'])[0].given).toEqual([
      ...above(1, GIVEN_LATER),
      ...above(3, GIVEN_LATER),
      ...above(10),
    ]);
    // A guess that does not move the hole gives nothing more, near or far.
    expect(replayCharge(holes(), RANKS, [...log, 'honnete3', 'honnete5', 'honnete999'])[0].given).toEqual(after.given);
  });

  it('nothing is given before the activation, whatever the hole did', () => {
    expect(replayCharge(holes(), RANKS, ['honnete1', 'honnete2', 'honnete3'])[0].given).toEqual([]);
  });

  it('a hole solved before its meter fills gives nothing, and the solve ends the giving', () => {
    expect(replayCharge(holes(), RANKS, ['honnete5', 'honnete'])[0].given).toEqual([]);
    const active = [...FOUR, FILLS];
    const solved = replayCharge(holes(), RANKS, [...active, 'honnete', 'honnete2'])[0];
    expect(solved.given).toEqual(replayCharge(holes(), RANKS, active)[0].given);
  });

  it('repeated occurrences share the given words', () => {
    const twice: RuntimeHole[] = [
      ...holes(),
      { pos: 7, secret: 'honnete', word: 'honnete50', rank: 50, startRank: 50 },
    ];
    const meters = replayCharge(twice, RANKS, [...FOUR, FILLS]);
    expect(meters[2]).toEqual(meters[0]);
    expect(meters[0].given).toEqual(above(1));
  });
});
