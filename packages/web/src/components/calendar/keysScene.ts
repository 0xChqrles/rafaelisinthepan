import {
  COUNT_EM,
  COUNT_ROWS,
  DIGIT_MASKS,
  SPARKLE_SHARE,
  bayerThreshold,
  countInk,
  foilCells,
  foilGlitter,
  foilInkRgb,
  inkEms,
  progressHeatColor,
} from '@whippin/shared';
import { DISSOLVE_MS, SKELETON_WAIT_MS } from '../bayerTiles';
import { easeOut } from '../meterRamp';
import { FRAME_MS, SHAKE, SHAKE_FRAME_MS } from '../podium/scene';
import { abgr, hexToAbgr } from '../raster';
import {
  COBALT as I_COBALT,
  DEEP as I_DEEP,
  DUSK as I_DUSK,
  GROUND as I_GROUND,
  INKS,
  MUTED as I_MUTED,
  RAIL as I_RAIL,
  WHITE as I_WHITE,
} from '../streak/sprites';
import { BLEED, type CalGeometry } from './geometry';
import type { DrawnCode } from './memory';

// THE MONTH AS IRON KEYS (the archive's subject): ONE raster of whole cells on the bare ground —
// the house's 2px cell, a canvas pixel each, scaled up `pixelated` — in the app's inks and
// nothing else, deterministic in `t` (the time since the scene began), so a frame is the same
// on every device and reduced motion is one `t` held. Its material is the board's: the
// podium's IRON, a block LIT FROM ABOVE (a slate cap, the light dithered down into the dusk
// face), each day a key of it, CHARGED from its foot the way the player watched their words
// fill — in that day's heat ink, as high as its %.
//
//   A DAY NEVER OPENED is the bare iron key, its number in white: the tappable picture every
//     played day is drawn on.
//   A PLAYED DAY is charged from its foot to its % — the meter's ramp stood upright: solid
//     ink, then three rows of dither behind the front — never under the foot's solid row (1%
//     still shows one) and never into the light band (a key under 100 is never full). Its
//     number reads the front as a HARD EDGE: cut out of the ink below it, white on the iron
//     above it, each with a cell of solid ring — never dithered, so no digit ever breaks.
//   A FINISHED DAY is charged THROUGH its cap and cooled to metal: solid cobalt with a deep
//     under-face falling in over its last quarter (the streak link's lit face over its
//     shade), its number cut out. Finished reads as SHAPE — a cobalt cap, a solid body, a
//     dark foot — against a high % (a slate cap, an iron band, a dithered front), never by
//     hue alone: orchid at 87% and cobalt are neighbours on the ramp.
//   A RUN: finished keys side by side are JOINED by the streak's edge-on link across the gap
//     (cobalt over deep), and a run carries on across a week's end — a stub out of the last
//     key into the bleed, one into the next week's first. Never foil, never called a streak
//     (a late solve joins a run here; the streak would not count it).
//   TODAY wears a WHITE cap — the key that is lit — and when it is finished it is the
//     screen's ONE shiny thing: the cobalt recedes into the FOIL.
//   A DAY TO COME is its number in slate on bare ground, no key at all; a pad is nothing.
//   A DAY NOT KNOWN YET (#211) is the key's GHOST: its shape as a slate checker round its
//     white number — no cap, no light band, so it never reads as a day not started — SPARSE
//     while the read is out (a light washing across it on the diagonal), the house's 50%
//     checker once it rests (failed, or never asked).
//
// THE BEATS (`keysBeats`): the month ARRIVES once per day (the screen's memory): keys dissolve
// in on the diagonal as plain iron, then the played ones CHARGE from their feet with a white
// write head, the finished ones LOCK through their caps (the cap white for two frames, then
// cobalt, the foot settling), and the links STAMP as each run closes; then TODAY DROPS — a
// white silhouette falling two steps, the impact, the podium's shake and a burst — and, if it
// is finished, its cobalt recedes into the foil. A day that CHANGED since the month was last
// drawn plays its own charge (a new solve locks, bursts and welds its run). Then the clock
// rests: nothing moves but today's foil.

// ── The inks: the streak raster's own — the tokens, nothing else — packed for the canvas ──
const ink = (index: number) => hexToAbgr(INKS[index - 1]);
const WHITE = ink(I_WHITE); // --fg: a playable number, the write head, today's cap
const MUTED = ink(I_MUTED); // --muted: the read wave's light
const RAIL = ink(I_RAIL); // --rail: iron's lit cap, a slate number, the ghost's checker
const COBALT = ink(I_COBALT); // --solve: a finished day
const DEEP = ink(I_DEEP); // cobalt's under-face: a finished key's foot, a link's shade
const GROUND = ink(I_GROUND); // --bg, opaque: a number cut out of its key
const DUSK = ink(I_DUSK); // iron's face
// `rgb(r, g, b)`, as `heat.ts` writes a colour.
function rgb(value: string): number {
  const [r, g, b] = value.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  return abgr(r, g, b);
}

// ── The model: what each of the grid's 42 cells shows ──────────────────────────────────────
export type KeyState =
  | { kind: 'pad' }
  | { kind: 'out'; day: number } // out of the playable window: its number in slate
  | { kind: 'unknown'; day: number } // the month has not arrived
  | { kind: 'none'; day: number }
  | { kind: 'progress'; day: number; pct: number } // 1–99: 100 is only ever a solve
  | { kind: 'solved'; day: number };

// The month's own state: its days are known, a read is out for them, or the read rests
// (failed, or never asked).
export type MonthPhase = 'data' | 'loading' | 'resting';

export interface KeysModel {
  keys: readonly KeyState[];
  // Today's cell, or -1 where the month does not hold it.
  today: number;
  phase: MonthPhase;
}

// A key's reading as the DRAWN memory keeps it.
export function codeOf(key: KeyState): DrawnCode | null {
  if (key.kind === 'none') return 'n';
  if (key.kind === 'progress') return `p${key.pct}`;
  if (key.kind === 'solved') return 's';
  return null;
}
const codeRank = (code: DrawnCode) => (code === 's' ? 101 : code === 'n' ? 0 : Number(code.slice(1)));
// Only an UPGRADE gets a ceremony: more done, or done.
export const isUpgrade = (from: DrawnCode, to: DrawnCode) => codeRank(to) > codeRank(from);

// ── The beats, in ms since the scene began ────────────────────────────────────────────────
// The ARRIVAL: each key dissolves in from its diagonal's beat in IN_STEPS hard steps over IN_MS
// (the podium's place); a played key charges from CHARGE_AT_MS + its beat, over its pace's
// charge; a turn's arrival runs quicker (the month already in the reader's eye). A finished
// key's cap flashes white FLASH_MS as it locks, and a link stamps LINK_AFTER_MS after the later
// of its two keys locks, white for FLASH_MS. TODAY drops at DROP_AT_MS: a white silhouette
// DROP_LIFTS cells up, a frame each, then the impact, the podium's shake and a burst; its cobalt
// recedes into the foil once the shake has played, over RECEDE_MS in RECEDE_STEPS (the podium's
// first place). A CHANGE: up to MAX_CEREMONIES days in date order, CHANGE_GAP_MS apart, each
// charging from what it said to what it says over TRAVEL_MS; the rest dissolve to their new
// picture. LOADING: the numbers dissolve in at once on the diagonal, the ghosts after the
// skeleton's wait (a quick read never flashes one); then the read wave, WAVE_FRAMES frames of
// WAVE_FRAME_MS, the first WAVE_LIT each lighting a diagonal.
export const PAST = -Infinity;
const PACES = {
  arrive: { diag: 30, charge: 240 },
  turn: { diag: 20, charge: 200 },
} as const;
const IN_MS = 160;
const IN_STEPS = 6;
const CHARGE_AT_MS = 200;
const FLASH_MS = 2 * FRAME_MS;
const LINK_AFTER_MS = FRAME_MS;
export const DROP_AT_MS = 800;
const DROP_LIFTS = [4, 2] as const;
const SHAKE_MS = SHAKE.length * SHAKE_FRAME_MS;
const RECEDE_MS = 400;
const RECEDE_STEPS = 8;
const MAX_CEREMONIES = 3;
const CHANGE_GAP_MS = 160;
const TRAVEL_MS = 240;
const CHANGE_STEPS = 8;
const WAVE_FRAME_MS = 80;
const WAVE_FRAMES = 20;
const WAVE_LIT = 12;
// The wave's light on a ghost: the checker's cells, or half of them (the diagonal just behind).
const SPARSE = 0.25;

export interface KeyChange {
  index: number;
  // What the day said when the month was last drawn.
  from: DrawnCode;
}

export interface KeysSpec {
  model: KeysModel;
  // The month ARRIVES (its first showing with data today): at the screen's opening pace, or
  // under a turn's quicker one. Null: it stands, settled from its first frame.
  build: 'arrive' | 'turn' | null;
  // TODAY drops: in the arrival (after the month has charged), or at once (the 22:00 flip).
  drop: 'build' | 'flip' | null;
  // The days that changed since the month was last drawn (a month already built).
  changes: readonly KeyChange[];
  // Loading: the numbers dissolve in (the screen's first frame), and the ghosts after the wait.
  digitsIn: boolean;
  ghostsIn: boolean;
  // Reduced motion: no wave (the still second signal, the checker's density, carries it).
  motion: boolean;
}

export interface LinkBeat {
  a: number;
  b: number;
  // Across a week's end: a stub out of `a` into the bleed, one into `b` from the other side.
  wrap: boolean;
  at: number;
}

export interface KeysBeats {
  // Per cell: when it starts coming in (PAST: standing) — the key in the arrival, the number
  // and the ghost while loading, a changed day's new picture.
  keyIn: number[];
  digitIn: number[];
  ghostIn: number[];
  dissolve: number[];
  // Per cell: when its charge starts (PAST: charged), from what (a change's old reading; null:
  // bare iron), and — finished — when it locks through the cap.
  charge: number[];
  chargeMs: number;
  from: (DrawnCode | null)[];
  lock: number[];
  links: LinkBeat[];
  // Today's drop: the silhouette's first frame and the impact (null: no drop).
  drop: number | null;
  impact: number | null;
  // Today's foil: undefined, none; null, born on (a revisit); else when the cobalt recedes.
  foil: number | null | undefined;
  // The read wave's first frame (null: none).
  wave: number | null;
  // The bursts behind the keys: today's impact, a new solve's lock.
  bursts: { index: number; at: number }[];
  // When nothing but a loop (the wave, the foil) moves any more.
  settled: number;
}

const diagOf = (i: number) => Math.floor(i / 7) + (i % 7);

export function keysBeats(spec: KeysSpec): KeysBeats {
  const { model } = spec;
  const n = model.keys.length;
  const past = () => new Array<number>(n).fill(PAST);
  const b: KeysBeats = {
    keyIn: past(),
    digitIn: past(),
    ghostIn: past(),
    dissolve: past(),
    charge: past(),
    chargeMs: PACES.arrive.charge,
    from: new Array<DrawnCode | null>(n).fill(null),
    lock: past(),
    links: [],
    drop: null,
    impact: null,
    foil: undefined,
    wave: null,
    bursts: [],
    settled: 0,
  };
  const ends = [0];

  if (model.phase !== 'data') {
    model.keys.forEach((key, i) => {
      if (key.kind === 'pad') return;
      if (spec.digitsIn) {
        b.digitIn[i] = diagOf(i) * PACES.arrive.diag;
        ends.push(b.digitIn[i] + IN_MS);
      }
      if (spec.ghostsIn && key.kind === 'unknown') {
        b.ghostIn[i] = SKELETON_WAIT_MS + diagOf(i) * PACES.arrive.diag;
        ends.push(b.ghostIn[i] + IN_MS);
      }
    });
    if (model.phase === 'loading' && spec.motion) b.wave = SKELETON_WAIT_MS;
    b.settled = settledAfter(ends);
    return b;
  }

  const today = model.today;
  const solved = (i: number) => model.keys[i]?.kind === 'solved';
  if (spec.drop !== null && today >= 0) {
    b.drop = spec.drop === 'flip' ? 0 : DROP_AT_MS;
    b.impact = b.drop + DROP_LIFTS.length * FRAME_MS;
    if (solved(today)) b.lock[today] = b.impact;
    b.bursts.push({ index: today, at: b.impact });
    ends.push(b.impact + SHAKE_MS);
  }
  if (spec.build !== null) {
    const pace = PACES[spec.build];
    b.chargeMs = pace.charge;
    model.keys.forEach((key, i) => {
      if (key.kind === 'pad' || (i === today && b.drop !== null)) return;
      b.keyIn[i] = diagOf(i) * pace.diag;
      ends.push(b.keyIn[i] + IN_MS);
      if (key.kind !== 'progress' && key.kind !== 'solved') return;
      b.charge[i] = CHARGE_AT_MS + diagOf(i) * pace.diag;
      ends.push(b.charge[i] + b.chargeMs + FRAME_MS);
      if (key.kind === 'solved') {
        b.lock[i] = b.charge[i] + b.chargeMs;
        ends.push(b.lock[i] + FLASH_MS);
      }
    });
  }
  if (spec.changes.length > 0) {
    b.chargeMs = TRAVEL_MS;
    const to = (c: KeyChange) => codeOf(model.keys[c.index]);
    const ups = spec.changes
      .filter((c) => {
        const code = to(c);
        return code !== null && isUpgrade(c.from, code);
      })
      .sort((x, y) => x.index - y.index)
      .slice(0, MAX_CEREMONIES);
    ups.forEach((c, k) => {
      const i = c.index;
      b.charge[i] = k * CHANGE_GAP_MS;
      b.from[i] = c.from;
      ends.push(b.charge[i] + TRAVEL_MS + FRAME_MS);
      if (solved(i)) {
        b.lock[i] = b.charge[i] + TRAVEL_MS;
        b.bursts.push({ index: i, at: b.lock[i] });
        ends.push(b.lock[i] + FLASH_MS);
      }
    });
    for (const c of spec.changes) {
      if (ups.includes(c)) continue;
      b.dissolve[c.index] = 0;
      ends.push(DISSOLVE_MS);
    }
  }
  // The runs: a link between two finished keys of a week, a pair of stubs across its end.
  for (let i = 0; i < n; i += 1) {
    if (!solved(i) || !solved(i + 1)) continue;
    const at = Math.max(b.lock[i], b.lock[i + 1]) + LINK_AFTER_MS;
    b.links.push({ a: i, b: i + 1, wrap: i % 7 === 6, at });
    ends.push(at + FLASH_MS);
  }
  if (today >= 0 && solved(today)) {
    // Today's foil comes once its moment has played: after the drop's shake, or after the lock
    // of a charge it played; a month already standing wears it from its first frame.
    b.foil =
      b.drop !== null && b.impact !== null
        ? b.impact + SHAKE_MS
        : b.lock[today] > PAST
          ? b.lock[today] + FLASH_MS
          : null;
    if (b.foil !== null) ends.push(b.foil + RECEDE_MS);
  }
  b.settled = settledAfter(ends);
  return b;
}

// The beats fall between frames (a diagonal's 20 or 30ms), and a frame shows the beat its
// start has reached: the scene has settled a whole frame after its last beat ends.
const settledAfter = (ends: readonly number[]) => Math.max(...ends) + FRAME_MS;

// ── The raster ────────────────────────────────────────────────────────────────────────────
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface KeysScene {
  // Paint the whole frame at `t` into `px` (cols × rows, ABGR) — today's foil with it, or not
  // (the resting frame the foil is repainted over); `pressed`, the key held down (or -1).
  draw: (px: Uint32Array, t: number, withFoil: boolean, pressed: number) => void;
  // Repaint only the FOIL at `t` over a frame drawn at rest.
  foil: (px: Uint32Array, rest: Uint32Array, t: number, pressed: number) => void;
  foilBoxes: readonly Box[];
  settled: number;
  // What still moves once settled: the read wave, today's foil, or nothing.
  loop: 'wave' | 'foil' | null;
}

// The frame a time falls in: the raster steps at FRAME_MS, so a beat lands on a frame.
const framed = (t: number) => Math.floor(t / FRAME_MS) * FRAME_MS;
const clamp01 = (k: number) => Math.max(0, Math.min(1, k));
// A dissolve's level at `t` from `from`, in `steps` hard steps over `ms` (1: whole).
const level = (from: number, ms: number, steps: number, ft: number) =>
  from === PAST ? 1 : Math.ceil(clamp01((ft - from) / ms) * steps) / steps;

// One key as it stands at a frame: the charge's front (rows inked from the foot), its ink, a
// flat fill (a finished charge) or the ramp, the write head's row, and the cap.
interface Iron {
  front: number;
  fill: number;
  flat: boolean;
  head: number;
  locked: boolean;
  capFlash: boolean;
  todayCap: boolean;
}

// `under`: the frame on screen as this scene began, which a key not yet come in still shows
// (the loading checker giving way key by key, a changed day's old picture).
export function keysScene(
  G: CalGeometry,
  model: KeysModel,
  tl: KeysBeats,
  seed: number,
  under: Uint32Array | null = null,
): KeysScene {
  const { cols, rows, keyW: W, keyH: H } = G;
  const put = (px: Uint32Array, x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    px[y * cols + x] = v;
  };
  const keyAt = (i: number) => ({
    x: BLEED + (i % 7) * (W + G.colGap),
    y: BLEED + Math.floor(i / 7) * (H + G.rowGap),
  });
  const corner = (lx: number, ly: number) => (lx === 0 || lx === W - 1) && (ly === 0 || ly === H - 1);
  // A key held down has lost its cap row: its new top row wears the cut corners.
  const shape = (lx: number, ly: number, down: number) =>
    !corner(lx, ly) && !(down && (ly === 0 || (ly === 1 && (lx === 0 || lx === W - 1))));
  // Rows under the cap; the charge's least and most front (a solid foot row; never the light
  // band), and a finished charge's, through the cap.
  const n = H - 1;
  const frontOf = (pct: number) => (pct <= 0 ? 0 : Math.min(n - 2, Math.max(3, (pct / 100) * n)));
  const FULL = H;
  // A finished key's foot: its last quarter falls into the deep, row by row.
  const footFrom = Math.ceil(0.75 * H);
  const heats = new Map<number, number>();
  const heat = (pct: number) => {
    let v = heats.get(pct);
    if (v === undefined) {
      v = rgb(progressHeatColor(pct));
      heats.set(pct, v);
    }
    return v;
  };

  // THE NUMBER: the 16px face on the type grid (a font pixel a cell), centred on its ink box in
  // the rows under the cap — and the cell of RING round it (its eight neighbours), where the
  // hard edge stands. 1: the digit's ink; 2: its ring.
  const maps = new Map<number, Uint8Array>();
  const digitMap = (day: number) => {
    let m = maps.get(day);
    if (m) return m;
    m = new Uint8Array(W * H);
    const text = String(day);
    const inkW = Math.round(inkEms(text.length) * COUNT_EM);
    const x0 = Math.floor((W - inkW) / 2);
    const y0 = 1 + Math.floor((H - 1 - COUNT_ROWS) / 2);
    const on = countInk(DIGIT_MASKS, text);
    for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
      for (let gx = 0; gx < text.length * COUNT_EM; gx += 1) {
        const x = x0 + gx;
        const y = y0 + gy;
        if (on(gx, gy) && x >= 0 && x < W && y >= 0 && y < H) m[y * W + x] = 1;
      }
    }
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (m[y * W + x] !== 1) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const rx = x + dx;
            const ry = y + dy;
            if (rx >= 0 && ry >= 0 && rx < W && ry < H && m[ry * W + rx] === 0) m[ry * W + rx] = 2;
          }
        }
      }
    }
    maps.set(day, m);
    return m;
  };

  // A played key's front and ink as it said `code` (a change's reading before its charge).
  const readingOf = (code: DrawnCode | null) =>
    code === null || code === 'n'
      ? { front: 0, fill: 0 }
      : code === 's'
        ? { front: FULL, fill: COBALT }
        : { front: frontOf(Number(code.slice(1))), fill: heat(Number(code.slice(1))) };

  const ironOf = (i: number, ft: number): Iron => {
    const key = model.keys[i];
    const done = key.kind === 'solved';
    const iron: Iron = {
      front: done ? FULL : key.kind === 'progress' ? frontOf(key.pct) : 0,
      fill: done ? COBALT : key.kind === 'progress' ? heat(key.pct) : 0,
      flat: false,
      head: -1,
      locked: false,
      capFlash: false,
      todayCap: i === model.today,
    };
    const lock = tl.lock[i];
    // Today lands whole: its impact is its lock, with no flash of its own.
    const landed = i === model.today && tl.impact !== null;
    if (done && (ft >= lock + FLASH_MS || (landed && ft >= lock))) {
      iron.locked = true;
      return iron;
    }
    const c0 = tl.charge[i];
    if (ft < c0) {
      const was = readingOf(tl.from[i]);
      iron.front = was.front;
      iron.fill = was.fill;
      return iron;
    }
    const end = c0 + tl.chargeMs;
    if (ft < end) {
      // Rising in whole rows, eased out, its top row the white write head.
      const f0 = readingOf(tl.from[i]).front;
      iron.front = Math.round(f0 + (iron.front - f0) * easeOut((ft - c0) / tl.chargeMs));
      iron.head = iron.front - 1;
      iron.flat = done;
      return iron;
    }
    if (done) {
      // The lock: through the cap, the cap white for two frames.
      iron.flat = true;
      iron.capFlash = true;
      return iron;
    }
    // The head takes its ink one frame after the front stops.
    if (ft < end + FRAME_MS) iron.head = Math.ceil(iron.front) - 1;
    return iron;
  };

  // A cell of an iron key (`dc`: the number's ink 1, its ring 2).
  const ironPixel = (k: Iron, lx: number, ly: number, dc: number): number => {
    const u = H - 1 - ly;
    if (k.locked) {
      if (dc === 1) return GROUND;
      if (dc === 2) return COBALT;
      if (k.todayCap && ly <= 1) return WHITE;
      if (ly >= footFrom) {
        if (ly === H - 1) return DEEP;
        return bayerThreshold(lx, ly) < (ly - footFrom) / (H - 1 - footFrom) ? DEEP : COBALT;
      }
      return COBALT;
    }
    // THE HARD EDGE: the number and its ring read the front, never the dither.
    const inked = u < k.front - 1.5;
    if (dc === 1) return inked ? GROUND : WHITE;
    if (dc === 2) return inked ? k.fill : DUSK;
    if (u === k.head) return WHITE;
    if (ly === 0 && k.capFlash) return WHITE;
    if (ly <= 1 && k.todayCap) return WHITE;
    if (k.front > 0 && u < k.front) {
      if (k.flat || bayerThreshold(lx, ly) < Math.min(1, (k.front - u) / 3)) return k.fill;
    }
    // Bare iron, lit from above: the slate cap, its light dithered into the dusk face.
    if (ly === 0) return RAIL;
    if (ly === 1) return bayerThreshold(lx, ly) < 0.5 ? RAIL : DUSK;
    if (ly === 2) return bayerThreshold(lx, ly) < 0.2 ? RAIL : DUSK;
    return DUSK;
  };

  // The read wave's light on diagonal `d` at a frame: 1 lit, 0.5 half-lit, 0 dark.
  const waveOn = (d: number, ft: number) => {
    if (tl.wave === null || ft < tl.wave) return 0;
    const f = Math.floor((ft - tl.wave) / WAVE_FRAME_MS) % WAVE_FRAMES;
    if (f >= WAVE_LIT) return 0;
    return d === f ? 1 : d === f - 1 ? 0.5 : 0;
  };
  // A cell of a ghost: its number white in a clearing, its shape a slate checker — sparse while
  // a read is out, the house's 50% at rest.
  const ghostPixel = (lx: number, ly: number, dc: number, lit: number): number => {
    if (dc === 1) return WHITE;
    if (dc === 2) return GROUND;
    if (corner(lx, ly)) return 0;
    const th = bayerThreshold(lx, ly);
    const on = model.phase === 'loading' ? th < SPARSE : ((lx + ly) & 1) === 0;
    if (!on) return 0;
    if (lit === 1 || (lit === 0.5 && th < SPARSE / 2)) return MUTED;
    return RAIL;
  };

  const drawKey = (px: Uint32Array, i: number, ft: number, pressed: number) => {
    const key = model.keys[i];
    if (key.kind === 'pad') return;
    const { x, y } = keyAt(i);
    const dmap = digitMap(key.day);
    const keep = (X: number, Y: number) => {
      if (under) put(px, X, Y, under[Y * cols + X]);
    };

    // TODAY DROPS: held back (the old picture standing) until its silhouette falls, a frame
    // each step, then it lands whole.
    if (i === model.today && tl.drop !== null && tl.impact !== null && ft < tl.impact) {
      if (ft < tl.drop) {
        for (let ly = 0; ly < H; ly += 1) for (let lx = 0; lx < W; lx += 1) keep(x + lx, y + ly);
        return;
      }
      const lift = DROP_LIFTS[Math.min(DROP_LIFTS.length - 1, Math.floor((ft - tl.drop) / FRAME_MS))];
      for (let ly = 0; ly < H; ly += 1) {
        for (let lx = 0; lx < W; lx += 1) if (!corner(lx, ly)) put(px, x + lx, y + ly - lift, WHITE);
      }
      return;
    }

    let dx = 0;
    let dy = 0;
    if (i === model.today && tl.impact !== null && ft >= tl.impact && ft < tl.impact + SHAKE_MS) {
      [dx, dy] = SHAKE[Math.floor((ft - tl.impact) / SHAKE_FRAME_MS)];
    }
    const down = i === pressed && key.kind !== 'out' ? 1 : 0;
    const lvIn = Math.min(
      level(tl.keyIn[i], IN_MS, IN_STEPS, ft),
      level(tl.dissolve[i], DISSOLVE_MS, CHANGE_STEPS, ft),
    );
    const lvDigit = model.phase === 'data' ? lvIn : level(tl.digitIn[i], IN_MS, IN_STEPS, ft);
    const lvGhost = level(tl.ghostIn[i], IN_MS, IN_STEPS, ft);
    const iron = key.kind === 'none' || key.kind === 'progress' || key.kind === 'solved' ? ironOf(i, ft) : null;
    const lit = key.kind === 'unknown' ? waveOn(diagOf(i), ft) : 0;
    // (Offsets only once the key has come in whole: what gives way gives way where it stood.)
    const still = lvIn < 1 || lvDigit < 1;
    for (let ly = 0; ly < H; ly += 1) {
      for (let lx = 0; lx < W; lx += 1) {
        const X = x + lx;
        const Y = y + ly;
        const dc = dmap[ly * W + lx];
        const lv = key.kind === 'unknown' ? (dc === 1 ? lvDigit : lvGhost) : key.kind === 'out' ? lvDigit : lvIn;
        if (lv < 1 && bayerThreshold(X, Y) >= lv) {
          keep(X, Y);
          continue;
        }
        let v = 0;
        if (key.kind === 'out') v = dc === 1 ? RAIL : 0;
        else if (key.kind === 'unknown') v = ghostPixel(lx, ly, dc, lit);
        else if (iron && shape(lx, ly, down)) v = ironPixel(iron, lx, ly, dc);
        if (v !== 0) put(px, X + (still ? 0 : dx), Y + (still ? 0 : dy + down), v);
      }
    }
  };

  // A LINK between two finished keys of a week — the streak's edge-on bar across the gap, its
  // lit face over its under-face — or a WRAP's two stubs, thinning as they leave into the bleed.
  // Each stamps in white for two frames.
  const m = Math.floor(H / 2);
  const linkInk = (row: number, white: boolean) => (white ? WHITE : row < m ? COBALT : DEEP);
  const drawLink = (px: Uint32Array, link: LinkBeat, ft: number) => {
    if (ft < link.at) return;
    const white = ft < link.at + FLASH_MS;
    const a = keyAt(link.a);
    if (!link.wrap) {
      const bx = keyAt(link.b).x;
      for (let r = m - 2; r <= m + 1; r += 1) {
        for (let x = a.x + W; x < bx; x += 1) put(px, x, a.y + r, linkInk(r, white));
      }
      return;
    }
    const b = keyAt(link.b);
    for (let r = m - 2; r <= m + 1; r += 1) {
      for (let j = 0; j < BLEED; j += 1) {
        const thin = j === 2 ? 0.5 : j === 3 ? 0.25 : 1;
        const out = { x: a.x + W + j, y: a.y + r };
        const into = { x: b.x - 1 - j, y: b.y + r };
        if (bayerThreshold(out.x, out.y) < thin) put(px, out.x, out.y, linkInk(r, white));
        if (bayerThreshold(into.x, into.y) < thin) put(px, into.x, into.y, linkInk(r, white));
      }
    }
  };

  // TODAY'S FOIL: the shared material over its key's shape (its number still cut out), the
  // cobalt receding into it cell by cell in the Bayer order, then glitter once it is whole.
  const today = model.today;
  const foilOn = today >= 0 && tl.foil !== undefined && model.keys[today]?.kind === 'solved';
  const foilBox = foilOn ? (() => ({ ...keyAt(today), w: W, h: H + 1 }))() : null;
  const foilBoxes: Box[] = foilBox ? [foilBox] : [];
  const paintFoil = (px: Uint32Array, t: number, pressed: number) => {
    if (!foilOn || tl.foil === undefined) return;
    const ft = framed(t);
    const from = tl.foil;
    if (from !== null && ft < from) return;
    const key = model.keys[today];
    if (key.kind === 'pad') return;
    const { x, y } = keyAt(today);
    const down = pressed === today ? 1 : 0;
    const dmap = digitMap(key.day);
    // (Asked at a cell's centre.)
    const inside = (cx: number, cy: number) => {
      const lx = Math.floor(cx);
      const ly = Math.floor(cy);
      return lx >= 0 && ly >= 0 && lx < W && ly < H && shape(lx, ly, down) && dmap[ly * W + lx] !== 1;
    };
    const solid = from === null ? 0 : Math.ceil((1 - clamp01((ft - from) / RECEDE_MS)) * RECEDE_STEPS) / RECEDE_STEPS;
    const seconds = t / 1000;
    foilCells(W, H, seconds, seed, from === null ? null : from / 1000, inside, 1, (v, fx, fy) => {
      const X = x + fx;
      const Y = y + fy + down;
      if (solid > 0 && bayerThreshold(X, Y) < solid) return;
      const [r, g, b] = foilInkRgb(v);
      put(px, X, Y, abgr(r, g, b));
    });
    if (solid > 0) return;
    foilGlitter(W, H, seconds, seed, inside, SPARKLE_SHARE, 1, (gx, gy, w, h) => {
      for (let yy = 0; yy < h; yy += 1) {
        for (let xx = 0; xx < w; xx += 1) if (inside(gx + xx, gy + yy)) put(px, x + gx + xx, y + gy + yy + down, WHITE);
      }
    });
  };

  const draw = (px: Uint32Array, t: number, withFoil: boolean, pressed: number) => {
    px.fill(0);
    const ft = framed(t);
    if (model.phase === 'data') for (const link of tl.links) drawLink(px, link, ft);
    for (let i = 0; i < model.keys.length; i += 1) drawKey(px, i, ft, pressed);
    if (withFoil) paintFoil(px, t, pressed);
  };

  const foil = (px: Uint32Array, rest: Uint32Array, t: number, pressed: number) => {
    for (const b of foilBoxes) {
      for (let y = b.y; y < b.y + b.h && y < rows; y += 1) {
        const from = y * cols + b.x;
        px.set(rest.subarray(from, from + Math.min(b.w, cols - b.x)), from);
      }
    }
    paintFoil(px, t, pressed);
  };

  const loop = model.phase === 'loading' && tl.wave !== null ? 'wave' : foilOn ? 'foil' : null;
  return { draw, foil, foilBoxes, settled: tl.settled, loop };
}
