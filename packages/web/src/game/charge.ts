// THE HOLE'S CHARGE METER (#301, user-decided 2026-09-15): a near guess that does not
// beat a hole's best word still proves the player understands the neighbourhood, and
// until now it looked like a failure because the visible hole did not move. Every counted
// guess now CHARGES every unsolved hole by its own rank in that secret's map — whether or
// not it is a new best — and a full meter reveals the secret's first letter, once.
//
// It is a game mechanic, not a hint button: the guesses that fill the meter are the cost,
// and they count toward the round score exactly as today. A fast solve never fills it.
//
// DERIVED FROM THE PLAY LOG, never persisted: replaying the same log reconstructs the same
// meter and the same revealed initial on any device, exactly like the board. There is no
// charge-specific dedup, cooldown or farming rule — the play log's own canonical identity
// (`guessKey`) already decides what a counted guess is, and this reads that log as given.

import type { RankMap, RuntimeHole } from '@whippin/shared';

// The meter's target; charge caps here and the reveal fires the moment it is reached.
export const CHARGE_TARGET = 100;

// What a guess's rank in a secret's map pays is a CONTINUOUS FUNCTION of the rank, never a
// table of bands (user-decided 2026-09-15): CHARGE_NEAR for the nearest word, falling by the
// same amount every time the distance doubles — linear in ln(rank), the log reading of
// distance the progress score and the heat already use; 2.66 a doubling — down to
// CHARGE_FAR at CHARGE_REACH, so a word ranked 999 still pays ("words from 0 to 1000 should
// give you points"). Past the reach, or absent from the map, a guess pays nothing; rank 0 is
// the solve and never asks.
//
// CALIBRATED ON REAL PLAY: replayed over the production rounds of 2026-09-15, half the holes
// a player is stuck on get their initial by try ~37 (the user's "around 25/30 tries", then
// "reduce this a bit, by maybe ~20%"), and a fast solve almost never sees one.
// `charge.test.ts` pins the mix those holes actually see, so a retune restates it from real
// logs, never from an assumed mix. Keep the top this gentle: a steeper one fires the initial
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

// One hole's meter: its charge in [0, CHARGE_TARGET] and whether the initial is out.
// Repeated occurrences of one secret slug share one meter (one logical target, as
// reconstruction progress already treats them), so two holes can carry equal readings.
export interface HoleCharge {
  charge: number;
  revealed: boolean;
}

// The whole log replayed onto the holes' meters — the meters as the play log describes
// them, per hole index. A guess charges every secret whose map ranks it above zero and
// that is not yet solved; the guess that solves a secret pays it nothing (the solve is the
// reward), and nothing after the solve touches it either.
export function replayCharge(
  freshHoles: readonly RuntimeHole[],
  ranks: RankMap,
  log: readonly string[],
): HoleCharge[] {
  const meters = new Map<string, { charge: number; solved: boolean }>();
  for (const h of freshHoles) if (!meters.has(h.secret)) meters.set(h.secret, { charge: 0, solved: false });
  for (const typed of log) {
    for (const [secret, meter] of meters) {
      if (meter.solved) continue;
      const entry = ranks[secret]?.[typed];
      if (!entry) continue;
      if (entry.rank === 0) {
        meter.solved = true;
        continue;
      }
      meter.charge = Math.min(CHARGE_TARGET, meter.charge + chargeForRank(entry.rank));
    }
  }
  return freshHoles.map((h) => {
    const meter = meters.get(h.secret)!;
    return { charge: meter.charge, revealed: meter.charge >= CHARGE_TARGET };
  });
}

// The clue a full meter reveals: the secret's FIRST LETTER, and only that — never the
// word's length. The display form's first code point (an accent is part of the letter:
// `été` starts with `É`), upper-cased as a clue letter is written.
export function initialOf(word: string): string {
  const first = Array.from(word)[0];
  return first ? first.toUpperCase() : '';
}
