// CONTRACT (#301, user-decided 2026-09-15): every counted guess charges every unsolved
// hole by its rank in that secret's map, best word or not; the meter caps at 100 and a full
// meter reveals the first letter; rank 0 is the solve and pays nothing; repeated
// occurrences of one secret share one meter; charge is DERIVED from the play log, so a
// replay reconstructs it exactly.

import { describe, expect, it } from 'vitest';
import type { RankMap, RuntimeHole } from '@whippin/shared';
import { CHARGE_TARGET, chargeForRank, initialOf, replayCharge } from './charge';
import { replayHoles } from './scoring';

// One secret's map with a key at every rank the table's rows and edges need.
function mapAt(secret: string, ranks: number[]): RankMap[string] {
  const inner: RankMap[string] = { [secret]: { word: secret, rank: 0 } };
  for (const r of ranks) inner[`${secret}${r}`] = { word: `${secret}${r}`, rank: r };
  return inner;
}

const RANKS: RankMap = {
  honnete: mapAt('honnete', [1, 3, 4, 8, 10, 11, 14, 17, 25, 26, 50, 51, 100, 101, 250, 251]),
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

describe('chargeForRank — the table', () => {
  it('pays each band its charge, edges inclusive', () => {
    expect(chargeForRank(1)).toBe(30);
    expect(chargeForRank(3)).toBe(30);
    expect(chargeForRank(4)).toBe(18);
    expect(chargeForRank(10)).toBe(18);
    expect(chargeForRank(11)).toBe(12);
    expect(chargeForRank(25)).toBe(12);
    expect(chargeForRank(26)).toBe(7.5);
    expect(chargeForRank(50)).toBe(7.5);
    expect(chargeForRank(51)).toBe(4.5);
    expect(chargeForRank(100)).toBe(4.5);
    expect(chargeForRank(101)).toBe(1.5);
    expect(chargeForRank(250)).toBe(1.5);
  });

  it('a rank past 250, an absent rank and the solve pay nothing', () => {
    expect(chargeForRank(251)).toBe(0);
    expect(chargeForRank(undefined)).toBe(0);
    expect(chargeForRank(0)).toBe(0);
  });
});

describe('replayCharge — the meter as the play log describes it', () => {
  it('starts empty and unrevealed', () => {
    expect(replayCharge(holes(), RANKS, [])).toEqual([
      { charge: 0, revealed: false },
      { charge: 0, revealed: false },
    ]);
  });

  it('a guess that is NOT a new best still charges the hole', () => {
    // The hole shows rank 3; later guesses at 8, 14 and 17 leave the board alone…
    const log = ['honnete3', 'honnete8', 'honnete14', 'honnete17'];
    const board = replayHoles(holes(), RANKS, log);
    expect(board[0].rank).toBe(3);
    // …and each pays the meter by its own rank: 30 + 18 + 12 + 12.
    expect(replayCharge(holes(), RANKS, log)[0]).toEqual({ charge: 72, revealed: false });
  });

  it('caps at the target and reveals the moment it is reached', () => {
    const three = ['honnete1', 'honnete3', 'honnete4'];
    expect(replayCharge(holes(), RANKS, three)[0]).toEqual({ charge: 78, revealed: false });
    // 78 + 18 = 96: not yet.
    expect(replayCharge(holes(), RANKS, [...three, 'honnete10'])[0]).toEqual({
      charge: 96,
      revealed: false,
    });
    // 96 + 4.5 ≥ 100: capped, revealed.
    const full = replayCharge(holes(), RANKS, [...three, 'honnete10', 'honnete100'])[0];
    expect(full).toEqual({ charge: CHARGE_TARGET, revealed: true });
    // Once full, further near guesses change nothing.
    expect(replayCharge(holes(), RANKS, [...three, 'honnete10', 'honnete100', 'honnete1'])[0])
      .toEqual(full);
  });

  it('a miss and a far rank pay nothing', () => {
    expect(replayCharge(holes(), RANKS, ['zzz', 'honnete251'])[0].charge).toBe(0);
  });

  it('one guess charges several holes, each by its own rank in its own map', () => {
    // `bois` is rank 9 for the first secret (+18) and rank 2 for the second (+30).
    expect(replayCharge(holes(), RANKS, ['bois'])).toEqual([
      { charge: 18, revealed: false },
      { charge: 30, revealed: false },
    ]);
  });

  it('repeated occurrences of one secret share one meter', () => {
    const twice: RuntimeHole[] = [
      ...holes(),
      { pos: 7, secret: 'honnete', word: 'honnete50', rank: 50, startRank: 50 },
    ];
    const meters = replayCharge(twice, RANKS, ['honnete3', 'honnete8']);
    expect(meters[0]).toEqual({ charge: 48, revealed: false });
    expect(meters[2]).toEqual(meters[0]);
  });

  it('the exact hit is the solve: it pays nothing, and nothing after it touches the hole', () => {
    expect(replayCharge(holes(), RANKS, ['honnete'])[0]).toEqual({ charge: 0, revealed: false });
    const log = ['honnete3', 'honnete', 'honnete1', 'honnete1'];
    expect(replayCharge(holes(), RANKS, log)[0]).toEqual({ charge: 30, revealed: false });
    // The other hole is untouched by that secret's solve and keeps charging.
    expect(replayCharge(holes(), RANKS, [...log, 'foret2'])[1].charge).toBe(30);
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

describe('initialOf — the clue a full meter reveals', () => {
  it('is the first letter alone, upper-cased, accent kept', () => {
    expect(initialOf('honnête')).toBe('H');
    expect(initialOf('été')).toBe('É');
    expect(initialOf('œuf')).toBe('Œ');
    expect(initialOf('')).toBe('');
  });
});
