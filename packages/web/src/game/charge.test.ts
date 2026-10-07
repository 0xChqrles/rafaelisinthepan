// CONTRACT (#301, user-decided 2026-09-15; the activation user-decided 2026-09-22; the
// offer user-decided 2026-10-06): every counted guess charges every unsolved hole by its
// rank in that secret's map, best word or not; the meter caps at 100 and a full meter
// ACTIVATES the hole — it offers exactly ONE masked word, the rank at HALF the hole's best
// (the start, every rank reached, every hint revealed), rounded down, the next word closer
// where the map holds nothing that near, never the secret (a best of 1 offers nothing);
// the offered word guessed (typed or revealed) is a hint CONSUMED, stays given, is the new
// best, pays no charge and HALVES the meter, so the next offer waits for a full meter;
// a full meter at a best of 1 NAMES THE STRETCH instead (user-decided 2026-10-07): every
// word from the start down, free, for good until the solve;
// rank 0 is the solve and pays nothing; repeated occurrences of one secret share one meter
// and one mask; charge is DERIVED from the play log, so a replay reconstructs it exactly.

import { describe, expect, it } from 'vitest';
import type { RankMap } from '@whippin/shared';
import type { RuntimeHole } from './types';
import { CHARGE_TARGET, chargeForRank, replayCharge, strikeFor } from './charge';
import type { HoleCharge } from './charge';
import { replayHoles } from './scoring';
import { buildHistory } from './history';

// A meter's reading, its charge compared with a float's tolerance: the pay is continuous.
// A meter under its target offers nothing (the hints it already gave stay taken).
function expectMeter(meter: HoleCharge, charge: number, active: boolean) {
  expect(meter.charge).toBeCloseTo(charge, 9);
  expect(meter.active).toBe(active);
  if (!active) expect(meter.given.filter((g) => !g.consumed)).toEqual([]);
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
const FOUR = ['honnete2', 'honnete5', 'honnete10', 'honnete11'];
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
      { charge: 0, active: false, given: [], stretch: false },
      { charge: 0, active: false, given: [], stretch: false },
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
    // Four near guesses, ≈ 25.3 + 21.8 + 19.2 + 18.8 = 85.1: still not.
    const fourPay = chargeForRank(2) + chargeForRank(5) + chargeForRank(10) + chargeForRank(11);
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
    expect(replayCharge(holes(), RANKS, ['honnete'])[0]).toEqual({ charge: 0, active: false, given: [], stretch: false });
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

// CONTRACT (user-decided 2026-10-06): "we go from n to n/2, but using the hint also unfill
// the word by half" — once full, the hole offers one mask at half its best; taking it halves
// the meter, and the next one waits for the meter to fill again, down to the word just
// before the secret.
describe('the offer — one masked word at half the best, paid with half the meter', () => {
  // 4, 6, 30 … 33 fill the meter on 33: the best is 4.
  const BASE = [4, 6, 30, 31, 32, 33].map((r) => `honnete${r}`);
  // After the hint at 2 is taken, three near words fill the halved meter again: 50 plus
  // 3, 5 and 7's pay (≈ 66) — 3 and 5 alone leave it just under full.
  const REFILL = [3, 5, 7].map((r) => `honnete${r}`);
  const offered = (c: HoleCharge) => c.given.filter((g) => !g.consumed).map((g) => g.rank);

  it('nothing is given before the activation, whatever the hole did', () => {
    const almost = replayCharge(holes(), RANKS, BASE.slice(0, -1))[0];
    expect(almost.active).toBe(false);
    expect(almost.given).toEqual([]);
    expect(replayCharge(holes(), RANKS, ['honnete1', 'honnete2', 'honnete3'])[0].given).toEqual([]);
  });

  it('once full, exactly ONE mask: the rank at half the best, rounded down', () => {
    const active = replayCharge(holes(), RANKS, BASE)[0];
    expect(active.active).toBe(true);
    expect(replayHoles(holes(), RANKS, BASE)[0].rank).toBe(4);
    expect(active.given).toEqual([{ rank: 2, consumed: false }]);
  });

  it('the visible start is the best while nothing closer was found', () => {
    // Every guess is behind the start (50): the meter fills on them, the start is held.
    const log = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69].map((r) => `honnete${r}`);
    const meter = replayCharge(holes(), RANKS, log)[0];
    expect(meter.active).toBe(true);
    expect(meter.given).toEqual([{ rank: 25, consumed: false }]);
    // The start itself typed is no hint taken.
    expect(consumedOf(replayCharge(holes(), RANKS, [...log, 'honnete50'])[0])).toEqual([]);
  });

  it('a best of 1 offers nothing — the secret is never given — and its full meter NAMES THE STRETCH', () => {
    // These reach rank 1 on the way to filling the meter.
    const meter = replayCharge(holes(), RANKS, ['honnete1', 'honnete5', 'honnete10', 'honnete11', FILLS])[0];
    expectMeter(meter, CHARGE_TARGET, true);
    expect(meter.given).toEqual([]);
    expect(meter.stretch).toBe(true);
    // …and so does a meter filled again after the last hint, at 1.
    const refilled = replayCharge(holes(), RANKS, [...BASE, 'honnete2', ...REFILL, 'honnete1', 'honnete8', 'honnete10', 'honnete11'])[0];
    expectMeter(refilled, CHARGE_TARGET, true);
    expect(refilled.stretch).toBe(true);
    expect(refilled.given).toEqual([
      { rank: 1, consumed: true },
      { rank: 2, consumed: true },
    ]);
  });

  it('the offer guessed — revealed or typed — is CONSUMED, the hole improves to it, and it costs half the meter', () => {
    const one = replayCharge(holes(), RANKS, [...BASE, 'honnete2'])[0];
    expect(replayHoles(holes(), RANKS, [...BASE, 'honnete2'])[0].rank).toBe(2);
    expectMeter(one, CHARGE_TARGET / 2, false);
    expect(one.given).toEqual([{ rank: 2, consumed: true }]);
  });

  it('the next offer waits for the meter to fill again, then halves the new best', () => {
    const almost = replayCharge(holes(), RANKS, [...BASE, 'honnete2', ...REFILL.slice(0, -1)])[0];
    expectMeter(almost, CHARGE_TARGET / 2 + chargeForRank(3) + chargeForRank(5), false);
    expect(almost.given).toEqual([{ rank: 2, consumed: true }]);
    const full = replayCharge(holes(), RANKS, [...BASE, 'honnete2', ...REFILL])[0];
    expect(full.active).toBe(true);
    expect(full.given).toEqual([
      { rank: 1, consumed: false },
      { rank: 2, consumed: true },
    ]);
    // …down to the word just before the secret, and no further.
    const down = replayCharge(holes(), RANKS, [...BASE, 'honnete2', ...REFILL, 'honnete1'])[0];
    expectMeter(down, CHARGE_TARGET / 2, false);
    expect(down.stretch).toBe(false);
    expect(down.given).toEqual([
      { rank: 1, consumed: true },
      { rank: 2, consumed: true },
    ]);
  });

  it('a hint pays no charge: only the guesses after it refill the meter', () => {
    // Rank 2 would pay ≈ 24 as a typed word; taken as the offer, it pays nothing.
    const taken = replayCharge(holes(), RANKS, [...BASE, 'honnete2', 'honnete70'])[0];
    expectMeter(taken, CHARGE_TARGET / 2 + chargeForRank(70), false);
  });

  it('a closer word typed by hand moves the offer to half of it, the meter full; the old offer is neither given nor taken', () => {
    const jumped = replayCharge(holes(), RANKS, [...BASE, 'honnete3'])[0];
    expectMeter(jumped, CHARGE_TARGET, true);
    expect(jumped.given).toEqual([{ rank: 1, consumed: false }]);
    // The skipped rank typed afterwards is just a word the player found.
    expect(consumedOf(replayCharge(holes(), RANKS, [...BASE, 'honnete3', 'honnete2'])[0])).toEqual([]);
  });

  it('a farther guess leaves the offer where it is', () => {
    const active = replayCharge(holes(), RANKS, BASE)[0];
    expect(replayCharge(holes(), RANKS, [...BASE, 'honnete50', 'honnete999'])[0]).toEqual(active);
  });

  it('the half is walked through the ranks the map holds; nothing that near, the next word closer', () => {
    // A map with gaps: nothing between 2 and 7, nothing between 7 and 20.
    const sparse: RankMap = { lune: mapAt('lune', [1, 2, 7, 20, 21, 22, 23, 24, 900]) };
    const hole: RuntimeHole[] = [{ pos: 0, secret: 'lune', word: 'lune900', rank: 900, startRank: 900 }];
    const log = [7, 20, 21, 22, 23, 24].map((r) => `lune${r}`);
    // the best is 7: the half is 3, and the map's nearest word at or under it is 2
    expect(offered(replayCharge(hole, sparse, log)[0])).toEqual([2]);
    expect(replayCharge(hole, sparse, [...log, 'lune2'])[0].given).toEqual([{ rank: 2, consumed: true }]);
    // nothing at or under the half (9 → 4): the next word closer than the best
    const gap: RankMap = { lune: mapAt('lune', [5, 9, 20, 21, 22, 23, 24, 900]) };
    const fills = [9, 20, 21, 22, 23, 24].map((r) => `lune${r}`);
    expect(offered(replayCharge(hole, gap, fills)[0])).toEqual([5]);
  });

  it('a hole solved before its meter fills gives nothing, and the solve ends the giving', () => {
    expect(replayCharge(holes(), RANKS, ['honnete5', 'honnete'])[0].given).toEqual([]);
    const solved = replayCharge(holes(), RANKS, [...BASE, 'honnete', 'honnete2'])[0];
    expect(solved.given).toEqual(replayCharge(holes(), RANKS, BASE)[0].given);
    // A guess after the solve consumes nothing either.
    expect(consumedOf(solved)).toEqual([]);
  });

  it('repeated occurrences share one meter and one offer', () => {
    const twice: RuntimeHole[] = [
      ...holes(),
      { pos: 7, secret: 'honnete', word: 'honnete50', rank: 50, startRank: 50 },
    ];
    const meters = replayCharge(twice, RANKS, BASE);
    expect(meters[2]).toEqual(meters[0]);
    expect(ranksOf(meters[0])).toEqual([2]);
    // …and a hint taken is taken on the ONE meter they share, halving it once.
    const after = replayCharge(twice, RANKS, [...BASE, 'honnete2']);
    expect(consumedOf(after[0])).toEqual([2]);
    expectMeter(after[0], CHARGE_TARGET / 2, false);
    expect(after[2]).toEqual(after[0]);
  });

  it('replaying the same log reconstructs the same offer, and the history masks it below the best', () => {
    const log = [...BASE, 'honnete2', ...REFILL, 'honnete70'];
    const meter = replayCharge(holes(), RANKS, log)[0];
    expect(replayCharge(holes(), RANKS, [...log])[0]).toEqual(meter);
    const model = buildHistory({
      rankMap: RANKS.honnete, tried: log, hole: replayHoles(holes(), RANKS, log)[0],
      startRank: 50, secretWord: 'honnête', given: meter.given,
    });
    expect(model.stops.filter((s) => s.masked).map((s) => s.rank)).toEqual([1]);
    expect(model.stops.find((s) => s.best)!.rank).toBe(2);
    expect(model.stops.find((s) => s.rank === 2)).toMatchObject({ given: true, taken: true, masked: false });
  });
});

// 2026-10-07 (user-decided): "When you're at -1, and you have filled the word, you
// automatically get all the previous words revealed, from -1 to the starting word."
describe('the stretch — a full meter at a best of 1 names every word from the start down', () => {
  // Rank 1 on the way, the meter just under full (28 + 21.8 + 19.2 + 18.8), then full.
  const NEAR = ['honnete1', 'honnete5', 'honnete10', 'honnete11'];
  // A meter full at a best of 4, offering 2.
  const BASE_OFFER = [4, 6, 30, 31, 32, 33].map((r) => `honnete${r}`);

  it('needs BOTH: a best of 1 short of full, or a full meter above 1, names nothing', () => {
    const almost = replayCharge(holes(), RANKS, NEAR)[0];
    expect(almost.charge).toBeLessThan(CHARGE_TARGET);
    expect(almost.stretch).toBe(false);
    expect(almost.active).toBe(false);
    const above = replayCharge(holes(), RANKS, ['honnete2', ...FOUR.slice(1), FILLS])[0];
    expect(above.charge).toBe(CHARGE_TARGET);
    expect(above.stretch).toBe(false);
    expect(above.given).toEqual([{ rank: 1, consumed: false }]);
  });

  it('is free: no try, no charge — the meter stays full', () => {
    const named = replayCharge(holes(), RANKS, [...NEAR, FILLS])[0];
    expectMeter(named, CHARGE_TARGET, true);
    expect(named.stretch).toBe(true);
  });

  it('a closer word typed on a full meter, reaching 1, names it at once; the old offer is neither given nor taken', () => {
    const jumped = replayCharge(holes(), RANKS, [...BASE_OFFER, 'honnete1'])[0];
    expectMeter(jumped, CHARGE_TARGET, true);
    expect(jumped.stretch).toBe(true);
    expect(jumped.given).toEqual([]);
  });

  it('stays named whatever comes after it, until the solve', () => {
    const named = replayCharge(holes(), RANKS, [...NEAR, FILLS])[0];
    expect(replayCharge(holes(), RANKS, [...NEAR, FILLS, 'honnete70', 'honnete999'])[0]).toEqual(named);
    expect(replayCharge(holes(), RANKS, [...NEAR, FILLS, 'honnete'])[0].stretch).toBe(false);
  });

  it('repeated occurrences share it, and replaying the log names the same words in the history', () => {
    const twice: RuntimeHole[] = [
      ...holes(),
      { pos: 7, secret: 'honnete', word: 'honnete50', rank: 50, startRank: 50 },
    ];
    const log = [...NEAR, FILLS];
    const meters = replayCharge(twice, RANKS, log);
    expect(meters[2]).toEqual(meters[0]);
    const model = buildHistory({
      rankMap: RANKS.honnete, tried: log, hole: replayHoles(holes(), RANKS, log)[0],
      startRank: 50, secretWord: 'honnête', given: meters[0].given, stretch: meters[0].stretch,
    });
    expect(model.secret).toBeNull();
    expect(model.stops.map((s) => s.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(model.stops.filter((s) => !s.revealed).map((s) => s.rank)).toEqual([1, 5, 10, 11, 14, 50]);
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
