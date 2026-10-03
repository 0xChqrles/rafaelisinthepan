// THE COUNT'S RUN (pure, tested): what the result's count shows at each instant of the tally
// — ONE fixed length for every score (user-decided 2026-10-03: "a FIXED TIME for the
// animation, but whenever the score is 100 or 3, to give the feel of a RAPID COUNTING").
// `SolvedScreen` runs the clock (`ms` since the tally began); `SolvedCard` draws what this
// says at `ms`.
//
// THE COUNT IS A SLOT MACHINE (user-decided 2026-10-03: "all the digits spinning with a very
// short delay between them, they almost start at the same time, and they stop from left to
// right, and on each digit stop, there's a shake"): one REEL per digit of the score — 3 has
// one, 23 two, 137 three — each the face's ten glyphs on a strip (shared `countCells.ts` `reelInk`)
// resting on 0. The reels START almost together, COUNT_START_STAGGER_MS apart left to right,
// spin at COUNT_SPIN_RATE values a second, and STOP LEFT TO RIGHT, COUNT_STOP_GAP_MS apart, the
// last on COUNT_RUN_MS. A reel lands with a slot machine's snap: it BRAKES over COUNT_BRAKE_MS
// to COUNT_LOCK_RATE values a second, rolls ONE font pixel past its digit, holds there
// COUNT_SETTLE_MS, and drops into place — its stop. On its stop it SHAKES (`COUNT_SHAKE`,
// whole font pixels, one hard step every COUNT_SHAKE_FRAME_MS), and from then on it never
// moves. Each reel travels whole turns and its digit, as near as the spin's own pace takes it
// there: its speed is that pace, trimmed to land exactly.
//
// THE RULER fills on the same clock (`countFilled`), try by try at an even pace, the last try
// written on the last stop.
//
// A score has at most three digits (`ROUND_GUESS_CAP`), so the first stop always leaves the
// reels a full spin.

export const COUNT_RUN_MS = 2000;
export const COUNT_START_STAGGER_MS = 60;
export const COUNT_STOP_GAP_MS = 350;
export const COUNT_SPIN_RATE = 30;
export const COUNT_BRAKE_MS = 560;
export const COUNT_LOCK_RATE = 4;
export const COUNT_SETTLE_MS = 50;
// The stop's shake, one [dx, dy] in the face's font pixels per frame: the slam down, then the
// recoil side to side (the hit art's frame, and its four frames: `strikeArt.ts` STRUCK_MS).
export const COUNT_SHAKE_FRAME_MS = 50;
export const COUNT_SHAKE: readonly (readonly [number, number])[] = [
  [0, 1],
  [-1, 0],
  [1, 0],
  [-1, 0],
];
export const COUNT_SHAKE_MS = COUNT_SHAKE.length * COUNT_SHAKE_FRAME_MS;
// The clock's end: the last reel's shake played out.
export const COUNT_END_MS = COUNT_RUN_MS + COUNT_SHAKE_MS;

// One font pixel, in values (a glyph and its blank row are 8 font pixels: shared `countCells.ts`).
const PIXEL = 1 / 8;

// One reel at an instant: where its strip stands, in values (0 ≤ pos < 10; 3.5 is halfway
// from 3 to 4), and its shake, in font pixels.
export interface CountReel {
  pos: number;
  dx: number;
  dy: number;
}

// When reel `i` of `reels` (0 the leftmost) starts, and when it stops, in ms of the run.
export const reelStart = (i: number): number => i * COUNT_START_STAGGER_MS;
export const reelStop = (i: number, reels: number): number => COUNT_RUN_MS - (reels - 1 - i) * COUNT_STOP_GAP_MS;

// A reel's run: how long it spins up to its overshoot (seconds), how far it travels to its
// digit (values), and its full speed (values a second).
function reelPlan(digit: number, i: number, reels: number) {
  const spin = (reelStop(i, reels) - COUNT_SETTLE_MS - reelStart(i)) / 1000;
  const brake = COUNT_BRAKE_MS / 1000;
  const paced = COUNT_SPIN_RATE * spin - ((COUNT_SPIN_RATE - COUNT_LOCK_RATE) * brake) / 2 - PIXEL;
  const travel = digit + 10 * Math.round((paced - digit) / 10);
  const speed = (travel + PIXEL - (COUNT_LOCK_RATE * brake) / 2) / (spin - brake / 2);
  return { spin, brake, travel, speed };
}

// Where reel `i` of `reels`, landing on `digit`, stands at `ms`, UNWRAPPED: values travelled
// since its rest on 0.
export function reelTravelled(digit: number, i: number, reels: number, ms: number): number {
  const start = reelStart(i);
  const stop = reelStop(i, reels);
  if (ms <= start) return 0;
  const { spin, brake, travel, speed } = reelPlan(digit, i, reels);
  if (ms >= stop) return travel;
  const u = (ms - start) / 1000;
  if (u >= spin) return travel + PIXEL;
  const braking = u - (spin - brake);
  if (braking <= 0) return speed * u;
  return speed * u - ((speed - COUNT_LOCK_RATE) * braking * braking) / (2 * brake);
}

// Reel `i`'s shake at `ms`: [dx, dy] in font pixels, still outside its frames.
export function reelShake(i: number, reels: number, ms: number): readonly [number, number] {
  const since = ms - reelStop(i, reels);
  if (since < 0 || since >= COUNT_SHAKE_MS) return [0, 0];
  return COUNT_SHAKE[Math.floor(since / COUNT_SHAKE_FRAME_MS)];
}

// The reels at `ms`, the leftmost first — one per digit of the score. At rest every reel
// stands on 0; once the last has stopped they read the score.
export function countReels(score: number, ms: number): CountReel[] {
  const digits = Array.from(String(Math.max(0, Math.floor(score))), Number);
  return digits.map((digit, i) => {
    const [dx, dy] = reelShake(i, digits.length, ms);
    return { pos: reelTravelled(digit, i, digits.length, ms) % 10, dx, dy };
  });
}

// What the reels read, digit by digit (a reel mid-roll reads the digit it is leaving).
export function reelsText(reels: readonly CountReel[]): string {
  return reels.map((r) => String(Math.floor(r.pos) % 10)).join('');
}

// How many tries the ruler has written at `ms`: an even share of them, all of them on the
// last stop.
export function countFilled(score: number, ms: number): number {
  if (score <= 0 || ms <= 0) return 0;
  if (ms >= COUNT_RUN_MS) return score;
  return Math.min(score, Math.floor((score * ms) / COUNT_RUN_MS));
}
