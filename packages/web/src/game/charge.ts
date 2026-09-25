// THE HOLE'S CHARGE METER (#301, user-decided 2026-09-15): a near guess that does not
// beat a hole's best word still proves the player understands the neighbourhood, and
// until now it looked like a failure because the visible hole did not move. Every counted
// guess now CHARGES every unsolved hole by its own rank in that secret's map — whether or
// not it is a new best — and a full meter ACTIVATES the hole (user-decided 2026-09-22,
// replacing the secret's first letter): words are GIVEN — MASKED slots in the hole's
// tries, each one a hint the player may REVEAL from the wheel at the price of a try. The
// letter was a spelling clue in a meaning game; a neighbourhood says what the word IS
// ("10 more words actually always give a better idea of the concept" — the user, on the
// play data).
//
// THE GIVEN WORDS FOLLOW THE PLAYER'S OWN WORDS (user-decided 2026-09-25, replacing the
// five drawn ONCE from the best word at the activation, a player stuck on a joke they had
// not seen): once the meter is full, every word the hole holds — the visible start, every
// rank the log reached, every hint revealed — opens the nearest word FARTHER than it that
// the player does not have ("if I found 4 and 6, let's give 5 and 7, and if I unlock 7 and
// find 2, let's give 8 and 3"), and the hole shows the `GIVEN` openings nearest the secret
// ("max 5 available words at the same time"), recomputed after every guess: a revealed
// hint opens the next, and a closer word can push the farthest unrevealed mask out. A
// hint TAKEN stays given for good. Never a word closer than one the player has.
//
// THE HINTS ARE MASKED, AND A REVEAL IS A GUESS (user-decided 2026-09-22: "making the hint
// words masked, and you can just select them with the wheel, it counts as a guess, but
// this way users who don't want help don't get penalized, and those who need help just
// increase their score in return… you manage your own pace"): revealing a masked word is
// submitting it as a guess — it enters the play log like any typed word, counts as a try,
// charges the other holes, syncs. So the log alone says what was CONSUMED: a given rank
// guessed after it was given. A rank the player had ALREADY guessed is not a hint at all
// (they knew the word): it is never given, and the next farther word takes its place, so
// the next word the player does not have is opened in its place.
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

// How many masked words an active hole shows AT ONCE (user-decided 2026-09-23: 5, "lower is
// safer at first"; 2026-09-25: "max 5 available words at the same time").
export const GIVEN = 5;

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

// WHICH BLOW a guess lands on a hole it reaches (user-decided 2026-09-23: "only play the
// slashing animation when the guess give something, either it fills the word, or the guess
// is closer"). The exact hit wears the ULTRA star. A NEW guess is CUT when it GIVES the hole
// something — charge on its meter (`gained`), or a rank closer than the hole's best — and
// nothing else is: a repeat, a far word, a word that fills nothing on a full meter and is no
// closer all keep the plain float. `best` is the hole's best BEFORE this guess, off the full
// log (a guess still in the air may already have moved it).
export type Strike = 'ultra' | 'slash';
export function strikeFor(rank: number | undefined, isNew: boolean, gained: number, best: number): Strike | undefined {
  if (rank === 0) return 'ultra';
  if (rank === undefined || !isNew) return undefined;
  return gained > 0 || rank < best ? 'slash' : undefined;
}

// One hole's meter: its charge in [0, CHARGE_TARGET], whether the hole is ACTIVE (the meter
// reached its target), and the ranks it has GIVEN — ascending, without repeats, empty until
// the activation: the hints TAKEN (CONSUMED: guessed while masked, the try spent) and the
// masks it shows now. Repeated occurrences of one secret slug share one
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

// The whole log replayed onto the holes' meters — the meters as the play log describes
// them, per hole index. A guess charges every secret whose map ranks it above zero and
// that is not yet solved; the guess that solves a secret pays it nothing (the solve is the
// reward), and nothing after the solve touches it either.
//
// THE GIVEN WORDS, from the guess that fills the meter on (the guess that fills it opens
// its own word too): after every guess the hole holds, each word it holds opens the
// nearest rank farther than it that the player has not reached, walked through the ranks
// the map holds, and the GIVEN openings nearest the secret are its masks — fewer only when
// the map runs out. A mask guessed is a hint taken, and stays given. A hole solved before
// its meter fills gives nothing; the post-mortem names its stretch anyway.
export function replayCharge(
  freshHoles: readonly RuntimeHole[],
  ranks: RankMap,
  log: readonly string[],
): HoleCharge[] {
  interface Meter {
    charge: number;
    solved: boolean;
    guessed: Set<number>; // the visible start and every rank the log has reached so far
    masked: number[]; // the masks the hole shows now, ascending
    taken: Set<number>; // the hints guessed while masked
  }
  const meters = new Map<string, Meter>();
  for (const h of freshHoles) {
    if (!meters.has(h.secret)) {
      meters.set(h.secret, { charge: 0, solved: false, guessed: new Set([h.rank]), masked: [], taken: new Set() });
    }
  }
  // Each secret's map as its distinct ranks, ascending — the walk outward from a word.
  const ladders = new Map<string, number[]>();
  const ladder = (secret: string): number[] => {
    let rungs = ladders.get(secret);
    if (!rungs) {
      rungs = [...new Set(Object.values(ranks[secret] ?? {}).map((e) => e.rank))]
        .filter((r) => r > 0)
        .sort((a, b) => a - b);
      ladders.set(secret, rungs);
    }
    return rungs;
  };
  // Every word held opens the nearest rank farther than it that the player has not
  // reached; the GIVEN openings nearest the secret are the masks.
  const masksOf = (meter: Meter, secret: string): number[] => {
    const rungs = ladder(secret);
    const openings = new Set<number>();
    for (const held of meter.guessed) {
      let lo = 0;
      let hi = rungs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rungs[mid] <= held) lo = mid + 1;
        else hi = mid;
      }
      while (lo < rungs.length && meter.guessed.has(rungs[lo])) lo += 1;
      if (lo < rungs.length) openings.add(rungs[lo]);
    }
    return [...openings].sort((a, b) => a - b).slice(0, GIVEN);
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
      // A mask guessed — typed or revealed from the wheel, the log cannot tell and need
      // not — is a hint consumed.
      if (meter.masked.includes(entry.rank)) meter.taken.add(entry.rank);
      meter.guessed.add(entry.rank);
      meter.charge = Math.min(CHARGE_TARGET, meter.charge + chargeForRank(entry.rank));
      if (meter.charge >= CHARGE_TARGET) meter.masked = masksOf(meter, secret);
    }
  }
  return freshHoles.map((h) => {
    const meter = meters.get(h.secret)!;
    return {
      charge: meter.charge,
      active: meter.charge >= CHARGE_TARGET,
      given: [
        ...[...meter.taken].map((rank) => ({ rank, consumed: true })),
        ...meter.masked.map((rank) => ({ rank, consumed: false })),
      ].sort((a, b) => a.rank - b.rank),
    };
  });
}
