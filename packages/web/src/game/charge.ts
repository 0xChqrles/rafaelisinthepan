// THE HOLE'S CHARGE METER (#301, user-decided 2026-09-15): a near guess that does not
// beat a hole's best word still proves the player understands the neighbourhood, and
// until now it looked like a failure because the visible hole did not move. Every counted
// guess now CHARGES every unsolved hole by its own rank in that secret's map — whether or
// not it is a new best — and a full meter ACTIVATES the hole (user-decided 2026-09-22,
// replacing the secret's first letter): the `GIVEN` words just above the hole's best word
// are GIVEN — MASKED slots in the hole's tries, each one a hint the player may REVEAL from
// the wheel at the price of a try — ONCE: nothing is given after the activation, and
// nothing given is ever taken back (user-decided 2026-09-23, retiring the one word each
// later improvement of the best used to add: "only the 10 words should be given, and
// nothing else after that"). The letter was a spelling clue in a meaning game; a
// neighbourhood says what the word IS ("10 more words actually always give a better idea
// of the concept" — the user, on the play data).
//
// THE HINTS ARE MASKED, AND A REVEAL IS A GUESS (user-decided 2026-09-22: "making the hint
// words masked, and you can just select them with the wheel, it counts as a guess, but
// this way users who don't want help don't get penalized, and those who need help just
// increase their score in return… you manage your own pace"): revealing a masked word is
// submitting it as a guess — it enters the play log like any typed word, counts as a try,
// charges the other holes, syncs. So the log alone says what was CONSUMED: a given rank
// guessed after it was given. A rank the player had ALREADY guessed is not a hint at all
// (they knew the word): it is never given, and the next farther word takes its place, so
// the activation always gives GIVEN (user-decided 2026-09-23: "if a user already guessed
// one of these 10 words, then we should find another farther word so it's always 10").
// The meter's guesses are the cost of the pool; each hint taken is one more try. A fast
// solve never fills it.
//
// DERIVED FROM THE PLAY LOG, never persisted: replaying the same log reconstructs the same
// meter and the same given words on any device, exactly like the board — the server stores
// nothing for it. There is no charge-specific dedup, cooldown or farming rule — the play
// log's own canonical identity (`guessKey`) already decides what a counted guess is, and
// this reads that log as given.

import type { RankMap, RuntimeHole } from '@whippin/shared';

// The meter's target; charge caps here and the activation fires the moment it is reached.
export const CHARGE_TARGET = 100;

// How many words the ACTIVATION gives: the nearest ones farther than the best (the hole
// moves only by the player's own guess), enough of them to triangulate the sense
// (user-decided 2026-09-22: "10 words above your closest", over "everything between your
// closest and the start").
export const GIVEN = 10;

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
// THE GIVEN WORDS are drawn ONCE, the moment the meter fills, from the best word AS IT
// STANDS AFTER THAT GUESS (a guess can fill the meter and improve the hole at once — the
// words are drawn from where the hole then shows): the GIVEN nearest ranks farther than
// it that the player has not reached, walked outward through the ranks the map holds —
// fewer only when the map runs out. Nothing is given after that, whatever the best does.
// A hole solved before its meter fills gives nothing; the post-mortem names its stretch
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
  // Give the GIVEN nearest ranks farther than the best, skipping any the player has
  // already reached — no hint to them — for the next farther one the map holds.
  const give = (meter: Meter, secret: string) => {
    const farther = new Set<number>();
    for (const entry of Object.values(ranks[secret] ?? {})) {
      if (entry.rank > meter.best && !meter.guessed.has(entry.rank)) farther.add(entry.rank);
    }
    for (const rank of [...farther].sort((a, b) => a - b).slice(0, GIVEN)) meter.given.set(rank, false);
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
      if (entry.rank < meter.best) meter.best = entry.rank;
      // The activation gives its words from the best as it now stands, and only then.
      if (!wasActive && meter.charge >= CHARGE_TARGET) give(meter, secret);
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
