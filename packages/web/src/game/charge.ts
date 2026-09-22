// THE HOLE'S CHARGE METER (#301, user-decided 2026-09-15): a near guess that does not
// beat a hole's best word still proves the player understands the neighbourhood, and
// until now it looked like a failure because the visible hole did not move. Every counted
// guess now CHARGES every unsolved hole by its own rank in that secret's map — whether or
// not it is a new best — and a full meter ACTIVATES the hole (user-decided 2026-09-22,
// replacing the secret's first letter): the `GIVEN` words just above the hole's best word
// are revealed, and as the best word improves, the words above the new best join them —
// nothing given is ever taken back. The letter was a spelling clue in a meaning game; a
// neighbourhood says what the word IS ("10 more words actually always give a better idea
// of the concept" — the user, on the play data).
//
// It is a game mechanic, not a hint button: the guesses that fill the meter are the cost,
// and they count toward the round score exactly as today. A fast solve never fills it. A
// given word typed is a try like any other — the log's canonical identity is the only
// notion of a counted guess, and no exemption is carved out for it (user-decided
// 2026-09-22: "if a user types it, it's on them").
//
// DERIVED FROM THE PLAY LOG, never persisted: replaying the same log reconstructs the same
// meter and the same given words on any device, exactly like the board — the server stores
// nothing for it. There is no charge-specific dedup, cooldown or farming rule — the play
// log's own canonical identity (`guessKey`) already decides what a counted guess is, and
// this reads that log as given.

import type { RankMap, RuntimeHole } from '@whippin/shared';

// The meter's target; charge caps here and the activation fires the moment it is reached.
export const CHARGE_TARGET = 100;

// How many words above the best one an activation, and each later improvement, gives:
// ranks best+1 … best+GIVEN. Farther than the best — the hole moves only by the player's own
// guess — and enough of them to triangulate the sense (user-decided 2026-09-22: "10 words
// above your closest", over "everything between your closest and the start").
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
// the activation. Repeated occurrences of one secret slug share one meter (one logical
// target, as reconstruction progress already treats them), so two holes can carry equal
// readings.
export interface HoleCharge {
  charge: number;
  active: boolean;
  given: number[];
}

// The whole log replayed onto the holes' meters — the meters as the play log describes
// them, per hole index. A guess charges every secret whose map ranks it above zero and
// that is not yet solved; the guess that solves a secret pays it nothing (the solve is the
// reward), and nothing after the solve touches it either.
//
// THE GIVEN WORDS follow the BEST word: the moment the meter fills, the window above the
// best word AS IT STANDS AFTER THAT GUESS (a guess can fill the meter and improve the hole
// at once — the window is drawn from where the hole then shows) is given; every later
// guess that improves the best gives the window above the new best. The windows
// accumulate — a window is never withdrawn — so the given ranks are their union. A hole
// solved before its meter fills gives nothing; the post-mortem names its stretch anyway.
export function replayCharge(
  freshHoles: readonly RuntimeHole[],
  ranks: RankMap,
  log: readonly string[],
): HoleCharge[] {
  const meters = new Map<string, { charge: number; solved: boolean; best: number; given: Set<number> }>();
  for (const h of freshHoles) {
    if (!meters.has(h.secret)) meters.set(h.secret, { charge: 0, solved: false, best: h.rank, given: new Set() });
  }
  const give = (meter: { best: number; given: Set<number> }) => {
    for (let r = meter.best + 1; r <= meter.best + GIVEN; r += 1) meter.given.add(r);
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
      const wasActive = meter.charge >= CHARGE_TARGET;
      meter.charge = Math.min(CHARGE_TARGET, meter.charge + chargeForRank(entry.rank));
      const improved = entry.rank < meter.best;
      if (improved) meter.best = entry.rank;
      // The activation gives once, from the best as it now stands; an active hole gives
      // again only when the best moves.
      if (meter.charge >= CHARGE_TARGET && (!wasActive || improved)) give(meter);
    }
  }
  return freshHoles.map((h) => {
    const meter = meters.get(h.secret)!;
    return {
      charge: meter.charge,
      active: meter.charge >= CHARGE_TARGET,
      given: [...meter.given].sort((a, b) => a - b),
    };
  });
}
