// THE HOLE'S CHARGE METER (#301, user-decided 2026-09-15): a near guess that does not
// beat a hole's best word still proves the player understands the neighbourhood, and
// until now it looked like a failure because the visible hole did not move. Every counted
// guess now CHARGES every unsolved hole by its own rank in that secret's map — whether or
// not it is a new best — and a full meter ACTIVATES the hole (user-decided 2026-09-22,
// replacing the secret's first letter): a word is GIVEN — a MASKED slot in the hole's
// tries, a hint the player picks from the wheel and REVEALS at the price of a try. The
// letter was a spelling clue in a meaning game; a neighbour says what the word IS.
//
// ONE WORD CLOSER THAN THE BEST (user-decided 2026-10-02: "instead of revealing 5 words
// before the closest one, we should be able to reveal ONE word CLOSER than the closest
// word"): once the meter is full, the hole offers exactly one masked word — the nearest
// rank in the secret's map BELOW the hole's best (the visible start, every rank the log
// reached, every hint revealed: the lowest of them). Taking it makes it the new best, so
// the next closer word is offered AT ONCE, one try each, down to the word just before the
// secret: the secret itself is never offered, so a best of 1 offers nothing. A closer
// word typed by hand moves the offer under it the same way. A hint TAKEN stays given.
//
// THE HINTS ARE MASKED, AND A REVEAL IS A GUESS (user-decided 2026-09-22: "making the hint
// words masked, and you can just select them with the wheel, it counts as a guess, but
// this way users who don't want help don't get penalized, and those who need help just
// increase their score in return… you manage your own pace"): revealing a masked word is
// submitting it as a guess — it enters the play log like any typed word, counts as a try,
// charges the other holes, syncs. So the log alone says what was CONSUMED: the offered
// rank guessed while it was offered, revealed or typed by hand ("it's on them").
// The meter's guesses are the cost of the first offer; each hint taken is one more try. A
// fast solve never fills it.
//
// DERIVED FROM THE PLAY LOG, never persisted: replaying the same log reconstructs the same
// meter and the same given words on any device, exactly like the board — the server stores
// nothing for it. There is no charge-specific dedup, cooldown or farming rule — the play
// log's own canonical identity (`guessKey`) already decides what a counted guess is, and
// this reads that log as given.

import type { RankEntry, RankMap } from '@whippin/shared';
import type { RuntimeHole } from './types';

// The meter's target; charge caps here and the activation fires the moment it is reached.
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
type Strike = 'ultra' | 'slash';
export function strikeFor(rank: number | undefined, isNew: boolean, gained: number, best: number): Strike | undefined {
  if (rank === 0) return 'ultra';
  if (rank === undefined || !isNew) return undefined;
  return gained > 0 || rank < best ? 'slash' : undefined;
}

// One hole's meter: its charge in [0, CHARGE_TARGET], whether the hole is ACTIVE (the meter
// reached its target), and the ranks it has GIVEN — ascending, empty until the activation:
// the hints TAKEN (CONSUMED: guessed while offered, the try spent) and the one mask it
// offers now, if any. Repeated occurrences of one secret slug share one meter and one
// mask (one logical target, as reconstruction progress already treats them), so two holes
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

// One secret's map as its distinct ranks above the secret, ascending — the ladder a hint
// steps down. One pass over the alias-expanded map — tens of thousands of keys on a real
// puzzle — and an active hole asks for it on every guess, so it is cached per map object,
// exactly like the history's near field: the maps are immutable for a puzzle's lifetime.
const ladderCache = new WeakMap<Record<string, RankEntry>, number[]>();

function ladder(rankMap: Record<string, RankEntry>): number[] {
  let rungs = ladderCache.get(rankMap);
  if (!rungs) {
    rungs = [...new Set(Object.values(rankMap).map((e) => e.rank))]
      .filter((r) => r > 0)
      .sort((a, b) => a - b);
    ladderCache.set(rankMap, rungs);
  }
  return rungs;
}

// The rank the map holds nearest BELOW `best` — the next word closer — or undefined when
// nothing but the secret is closer (rank 0 is never a rung). Walked through the ranks the
// map holds, so a map with a gap still offers its next word.
function closerThan(rankMap: Record<string, RankEntry>, best: number): number | undefined {
  const rungs = ladder(rankMap);
  let lo = 0;
  let hi = rungs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rungs[mid] < best) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? rungs[lo - 1] : undefined;
}

// The whole log replayed onto the holes' meters — the meters as the play log describes
// them, per hole index. A guess charges every secret whose map ranks it above zero and
// that is not yet solved; the guess that solves a secret pays it nothing (the solve is the
// reward), and nothing after the solve touches it either.
//
// THE OFFER, from the guess that fills the meter on: after every guess, the one rank
// closer than the hole's best. The offered rank guessed is a hint taken and stays given;
// it is the new best, so the next one is offered with it. A hole solved before its meter
// fills gives nothing; the post-mortem names its stretch anyway.
export function replayCharge(
  freshHoles: readonly RuntimeHole[],
  ranks: RankMap,
  log: readonly string[],
): HoleCharge[] {
  interface Meter {
    charge: number;
    solved: boolean;
    best: number; // the closest rank the hole holds: the visible start, or one the log reached
    offered: number | undefined; // the mask the hole offers now
    taken: Set<number>; // the hints guessed while offered
  }
  const meters = new Map<string, Meter>();
  for (const h of freshHoles) {
    if (!meters.has(h.secret)) {
      meters.set(h.secret, { charge: 0, solved: false, best: h.rank, offered: undefined, taken: new Set() });
    }
  }
  for (const typed of log) {
    for (const [secret, meter] of meters) {
      if (meter.solved) continue;
      const entry = ranks[secret]?.[typed];
      if (!entry) continue;
      if (entry.rank === 0) {
        meter.solved = true;
        continue;
      }
      // The offered word guessed — revealed from the wheel or typed, the log cannot tell
      // and need not — is a hint consumed.
      if (entry.rank === meter.offered) meter.taken.add(entry.rank);
      meter.best = Math.min(meter.best, entry.rank);
      meter.charge = Math.min(CHARGE_TARGET, meter.charge + chargeForRank(entry.rank));
      if (meter.charge >= CHARGE_TARGET) meter.offered = closerThan(ranks[secret], meter.best);
    }
  }
  return freshHoles.map((h) => {
    const meter = meters.get(h.secret)!;
    const given = [...meter.taken].map((rank) => ({ rank, consumed: true }));
    if (meter.offered !== undefined) given.push({ rank: meter.offered, consumed: false });
    return {
      charge: meter.charge,
      active: meter.charge >= CHARGE_TARGET,
      given: given.sort((a, b) => a.rank - b.rank),
    };
  });
}
