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

// What a guess's rank in a secret's map pays, as `[rank ceiling, charge]` rows, ascending.
// A rank past the last row — or absent from the map — pays nothing; rank 0 is the solve and
// never consults the table.
//
// TUNED TO A RUN, NOT TO A BAND (user-decided 2026-09-15, in two passes on play: the
// issue's 30 / 18 / 12 / 7.5 / 4.5 / 1.5 was "quite hard to unlock", a 50 / 34 / 25 / 18 /
// 12 / 6 answer "a bit too much" — "it should be something that unlocks naturally around
// 25/30 (good and bad) tries"). The yardstick is a TYPICAL ROUND: about half the tries far
// or missed (0), a quarter in the 101–250 band, 15% at 51–100, 10% at 26–50, 4% at 11–25,
// 1% at 4–10 — that mix pays ~3.7 a try here, so the initial comes at ~27 tries; a sharper
// run (a third far, the rest spread closer) pays ~5.4 and gets it at ~19. Band by band,
// with nothing else landing: four in the top three · five at 4–10 · eight at 11–25 · ten at
// 26–50 · fifteen at 51–100 · twenty-nine at 101–250. A far guess still pays nothing: the
// meter rewards the neighbourhood, not persistence.
export const CHARGE_TABLE: readonly (readonly [number, number])[] = [
  [3, 30],
  [10, 20],
  [25, 14],
  [50, 10],
  [100, 7],
  [250, 3.5],
];

export function chargeForRank(rank: number | undefined): number {
  if (rank === undefined || rank <= 0) return 0;
  for (const [ceiling, charge] of CHARGE_TABLE) if (rank <= ceiling) return charge;
  return 0;
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
