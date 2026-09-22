// THE HOLE'S CHARGE METER (#301, user-decided 2026-09-15): a near guess that does not
// beat a hole's best word still proves the player understands the neighbourhood, and
// until now it looked like a failure because the visible hole did not move. Every counted
// guess now CHARGES every unsolved hole by its own rank in that secret's map — whether or
// not it is a new best — and a full meter ACTIVATES the hole (user-decided 2026-09-22,
// replacing the secret's first letter): the `GIVEN` words just above the hole's best word
// are GIVEN — MASKED slots in the hole's tries, each one a hint the player may REVEAL from
// the wheel at the price of a try — and as the best word improves, the ONE word above each
// new best joins them (`GIVEN_LATER`; calibrated the same day: "10 words everytime is
// maybe too much… for the next words it should be one word only") — nothing given is ever
// taken back. The letter was a spelling clue in a meaning game; a neighbourhood says what
// the word IS ("10 more words actually always give a better idea of the concept" — the
// user, on the play data).
//
// THE HINTS ARE MASKED, AND A REVEAL IS A GUESS (user-decided 2026-09-22: "making the hint
// words masked, and you can just select them with the wheel, it counts as a guess, but
// this way users who don't want help don't get penalized, and those who need help just
// increase their score in return… you manage your own pace"): revealing a masked word is
// submitting it as a guess — it enters the play log like any typed word, counts as a try,
// charges the other holes, syncs. So the log alone says what was CONSUMED: a given rank
// guessed after it was given. A given rank the player had ALREADY guessed is not a hint at
// all (they knew the word) and is never given. The meter's guesses are the cost of the
// pool; each hint taken is one more try. A fast solve never fills it.
//
// DERIVED FROM THE PLAY LOG, never persisted: replaying the same log reconstructs the same
// meter and the same given words on any device, exactly like the board — the server stores
// nothing for it. There is no charge-specific dedup, cooldown or farming rule — the play
// log's own canonical identity (`guessKey`) already decides what a counted guess is, and
// this reads that log as given.

import type { RankMap, RuntimeHole } from '@whippin/shared';

// The meter's target; charge caps here and the activation fires the moment it is reached.
export const CHARGE_TARGET = 100;

// How many words above the best one the ACTIVATION gives — ranks best+1 … best+GIVEN,
// farther than the best (the hole moves only by the player's own guess) and enough of
// them to triangulate the sense (user-decided 2026-09-22: "10 words above your closest",
// over "everything between your closest and the start") — and how many each LATER
// improvement of the best gives: the one word just above it.
export const GIVEN = 10;
export const GIVEN_LATER = 1;

// What a guess's rank in a secret's map pays is a CONTINUOUS FUNCTION of the rank, never a
// table of bands (user-decided 2026-09-15): CHARGE_NEAR for the nearest word, falling by the
// same amount every time the distance doubles — linear in ln(rank), the log reading of
// distance the progress score and the heat already use; 2.66 a doubling — down to
// CHARGE_FAR at CHARGE_REACH, so a word ranked 999 still pays ("words from 0 to 1000 should
// give you points"). Past the reach, or absent from the map, a guess pays nothing; rank 0 is
// the solve and never asks.
//
// CALIBRATED ON REAL PLAY: replayed over the production rounds of 2026-09-15, half the holes
// a player is stuck on activate by try ~37 (the user's "around 25/30 tries", then
// "reduce this a bit, by maybe ~20%"), and a fast solve almost never sees it.
// `charge.test.ts` pins the mix those holes actually see, so a retune restates it from real
// logs, never from an assumed mix. Keep the top this gentle: a steeper one activates the hole
// just before solves that were coming anyway — the three nearest words pay 77 together.
const CHARGE_REACH = 1000;
const CHARGE_NEAR = 28;
const CHARGE_FAR = 1.5;

export function chargeForRank(rank: number | undefined): number {
  if (rank === undefined || rank <= 0 || rank > CHARGE_REACH) return 0;
  // Where the rank sits on the log scale: 0 at rank 1, 1 at the reach.
  const far = Math.log(rank) / Math.log(CHARGE_REACH);
  return CHARGE_NEAR + (CHARGE_FAR - CHARGE_NEAR) * far;
}

// One hole's meter: its charge in [0, CHARGE_TARGET], whether the hole is ACTIVE (the meter
// reached its target), and the ranks it has GIVEN — ascending, without repeats, empty until
// the activation — each saying whether the player CONSUMED it (guessed it after it was
// given: the hint taken, the try spent). Repeated occurrences of one secret slug share one
// meter (one logical target, as reconstruction progress already treats them), so two holes
// can carry equal readings.
export interface GivenRank {
  rank: number;
  consumed: boolean;
}
export interface HoleCharge {
  charge: number;
  active: boolean;
  given: GivenRank[];
}

// The hints a round took, over its distinct secrets (repeated occurrences share a meter).
export function hintsTaken(freshHoles: readonly RuntimeHole[], charges: readonly HoleCharge[]): number {
  const seen = new Set<string>();
  let n = 0;
  freshHoles.forEach((h, i) => {
    if (seen.has(h.secret)) return;
    seen.add(h.secret);
    n += charges[i].given.filter((g) => g.consumed).length;
  });
  return n;
}

// The whole log replayed onto the holes' meters — the meters as the play log describes
// them, per hole index. A guess charges every secret whose map ranks it above zero and
// that is not yet solved; the guess that solves a secret pays it nothing (the solve is the
// reward), and nothing after the solve touches it either.
//
// THE GIVEN WORDS follow the BEST word: the moment the meter fills, the GIVEN ranks above
// the best word AS IT STANDS AFTER THAT GUESS (a guess can fill the meter and improve the
// hole at once — the window is drawn from where the hole then shows) are given; every
// later guess that improves the best gives the GIVEN_LATER rank(s) above the new best.
// The windows accumulate — nothing is withdrawn — so the given ranks are their union. A
// hole solved before its meter fills gives nothing; the post-mortem names its stretch
// anyway.
export function replayCharge(
  freshHoles: readonly RuntimeHole[],
  ranks: RankMap,
  log: readonly string[],
): HoleCharge[] {
  interface Meter {
    charge: number;
    solved: boolean;
    best: number;
    guessed: Set<number>; // every rank the log has reached in this map, so far
    given: Map<number, boolean>; // rank -> consumed
  }
  const meters = new Map<string, Meter>();
  for (const h of freshHoles) {
    if (!meters.has(h.secret)) {
      meters.set(h.secret, { charge: 0, solved: false, best: h.rank, guessed: new Set(), given: new Map() });
    }
  }
  // Give the `count` ranks above the best — except one the player has already reached,
  // which is no hint to them.
  const give = (meter: Meter, count: number) => {
    for (let r = meter.best + 1; r <= meter.best + count; r += 1) {
      if (!meter.guessed.has(r) && !meter.given.has(r)) meter.given.set(r, false);
    }
  };
  for (const typed of log) {
    for (const [secret, meter] of meters) {
      if (meter.solved) continue;
      const entry = ranks[secret]?.[typed];
      if (!entry) continue;
      if (entry.rank === 0) {
        meter.solved = true;
        continue;
      }
      // A given rank guessed — typed or revealed from the wheel, the log cannot tell and
      // need not — is a hint consumed.
      if (meter.given.has(entry.rank)) meter.given.set(entry.rank, true);
      meter.guessed.add(entry.rank);
      const wasActive = meter.charge >= CHARGE_TARGET;
      meter.charge = Math.min(CHARGE_TARGET, meter.charge + chargeForRank(entry.rank));
      const improved = entry.rank < meter.best;
      if (improved) meter.best = entry.rank;
      // The activation gives its window from the best as it now stands; an active hole
      // gives again — one word — only when the best moves.
      if (meter.charge < CHARGE_TARGET) continue;
      if (!wasActive) give(meter, GIVEN);
      else if (improved) give(meter, GIVEN_LATER);
    }
  }
  return freshHoles.map((h) => {
    const meter = meters.get(h.secret)!;
    return {
      charge: meter.charge,
      active: meter.charge >= CHARGE_TARGET,
      given: [...meter.given]
        .map(([rank, consumed]) => ({ rank, consumed }))
        .sort((a, b) => a.rank - b.rank),
    };
  });
}
