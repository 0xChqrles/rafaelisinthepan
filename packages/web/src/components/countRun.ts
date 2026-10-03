// THE COUNT'S RUN (pure, tested): what the result's count reads at each instant of the
// tally — ONE fixed length for every score (user-decided 2026-10-03: "a FIXED TIME for the
// animation, but whenever the score is 100 or 3, to give the feel of a RAPID COUNTING"),
// always reading as a fast counter. `SolvedScreen` runs the clock (`p`, the share of
// COUNT_RUN_MS gone); `SolvedCard` draws what this says at `p`.
//
// THE COUNT IS AN ODOMETER: one REEL per digit, each the face's ten glyphs on a strip
// (`countCells.ts` `reelInk`), the ONES reel driving the rest — a reel above it turns only
// while the one under it rolls from 9 to 0. The ones reel travels whole TURNS and then the
// score's last digit: as many turns as the score has tens (137: thirteen turns and 7, every
// value read on its way), never fewer than COUNT_MIN_TURNS — a small score has too few
// values to count fast, so its reel SPINS those turns and locks on its digit, the reels
// above stepping on its LAST carries only (23: three turns under a slate 0, then 10…19,
// 20…23).
//
// THE PACE: the reels CRUISE at full speed for COUNT_CRUISE of the run, then BRAKE evenly
// into the value, still turning COUNT_LOCK_RATE values a second as they lock — a big score
// races up and decelerates into its value, a small one spins and clunks into place, and
// every run lands on the clock, at COUNT_RUN_MS.
//
// THE RULER fills on the same clock (`countFilled`): its share of the tries is the run's
// share of its travel, the last try written as the reels lock. Where the ones reel reads
// every value (a score of 10·COUNT_MIN_TURNS or more) the count and the ruler say the same
// number at every frame.

export const COUNT_RUN_MS = 2000;
export const COUNT_MIN_TURNS = 5;
export const COUNT_CRUISE = 0.45;
export const COUNT_LOCK_RATE = 12;

// One reel: where its strip stands, in values (0 ≤ pos < 10; 3.5 is halfway from 3 to 4),
// and whether the count has reached it yet (an unreached reel is the odometer's slate 0).
export interface CountReel {
  pos: number;
  live: boolean;
}

const turns = (score: number): number => Math.max(Math.floor(score / 10), COUNT_MIN_TURNS);

// How far the ones reel travels over the run, in values.
export function countTravel(score: number): number {
  return 10 * turns(score) + (score % 10);
}

// The share of its travel the ones reel has covered at `p` (the share of the run gone):
// full speed `s` until COUNT_CRUISE, then an even brake down to the lock's speed `f` at
// the end — both in travels per run, so the shape is the same at every score and only
// the lock's share changes with the travel.
export function countPace(travel: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const f = Math.min(1, (COUNT_LOCK_RATE * COUNT_RUN_MS) / 1000 / travel);
  const q = COUNT_CRUISE;
  const s = (2 - (1 - q) * f) / (1 + q);
  if (p <= q) return s * p;
  const d = p - q;
  return s * p - ((s - f) * d * d) / (2 * (1 - q));
}

// How many tries the ruler has written at `p`: the run's share of them, all of them as it
// lands.
export function countFilled(score: number, p: number): number {
  if (score <= 0) return 0;
  if (p >= 1) return score;
  return Math.min(score, Math.floor(score * countPace(countTravel(score), p)));
}

// An odometer reel `place` digits up a value: its digit, and the roll it takes while every
// reel under it rolls from 9 to 0.
function odometer(value: number, place: number): number {
  const unit = 10 ** place;
  return (Math.floor(value / unit) % 10) + Math.max(0, (value % unit) - (unit - 1));
}

// The reels at `p`, the most significant first — one per digit of the score. At rest (p 0)
// every reel stands on 0, the ones the only one reached; on the landing (p 1) they read the
// score exactly.
export function countReels(score: number, p: number): CountReel[] {
  const n = Math.max(0, Math.floor(score));
  const digits = String(n).length;
  if (p >= 1) return Array.from(String(n), (d) => ({ pos: Number(d), live: true }));
  const travel = countTravel(n);
  const ones = travel * countPace(travel, p);
  // The reels above the ones, read as ONE value: they wait out the spin's extra turns
  // (`lag`), then step on each carry — rolling with the ones reel's 9 → 0.
  const lag = turns(n) - Math.floor(n / 10);
  const carries = Math.floor(ones / 10);
  const roll = carries >= lag ? Math.max(0, (ones % 10) - 9) : 0;
  const upper = Math.max(0, carries - lag) + roll;
  const reels: CountReel[] = [];
  for (let i = 0; i < digits; i += 1) {
    const place = digits - 1 - i;
    reels.push(
      place === 0
        ? { pos: ones % 10, live: true }
        : { pos: odometer(upper, place - 1), live: Math.floor(upper) >= 10 ** (place - 1) },
    );
  }
  return reels;
}

// What the reels read, digit by digit (a reel mid-roll reads the digit it is leaving).
export function reelsText(reels: readonly CountReel[]): string {
  return reels.map((r) => String(Math.floor(r.pos) % 10)).join('');
}
