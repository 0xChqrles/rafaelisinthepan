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
import { easeOut, rampDensity } from '../meterRamp';
import { FRAME_MS, RECEDE_MS, SHAKE, SHAKE_FRAME_MS, framed, recedeLevel, type Box } from '../podium/scene';
import { abgr, rgbToAbgr } from '../raster';
import { BURST_ART } from '../strikeArt';
import { clamp01 } from '../streak/beats';
import {
  COBALT as I_COBALT,
  DEEP as I_DEEP,
  DUSK as I_DUSK,
  GROUND as I_GROUND,
  MUTED as I_MUTED,
  RAIL as I_RAIL,
  WHITE as I_WHITE,
  inkAbgr,
} from '../streak/sprites';
import { keyAt, type CalGeometry } from './geometry';
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
//     still shows one) and never into the iron's top four rows: a key under 100 always shows
//     its slate cap, its two rows of light and a row of its face (the ramp itself leaves a
//     second face row too; only a whole number's ring, on the smallest keys, stands in it).
//     Its number reads the front as a HARD EDGE: cut out of the ink below it, white on the
//     iron above it, each with a cell of solid ring — never dithered, and never cut into a
//     sliver: the edge crosses a number between its third and fifth rows or not at all, so no
//     digit ever breaks. The edge is the %'s, the same on every day at that %, and the front
//     AGREES with it where it can, two rows away at most: no ink ring over a row barely
//     inked, no dusk ring in a row mostly ink. Where it cannot, the height wins.
//   A FINISHED DAY is charged THROUGH its cap and cooled to metal: lit cobalt from its cap
//     down, falling into the deep under-face under its number — the streak link's lit face
//     over its shade, so a month of them reads as rows of lit tops over dark feet, never a
//     wall — its number cut out of a band of solid cobalt. Finished reads as SHAPE — a bright
//     top, a dark foot — against a high % (a dark iron top, ink solid to the foot), never by
//     hue alone: orchid at 87% and cobalt are neighbours on the ramp, and a colour-blind eye
//     takes one for the other.
//   AN OVER DAY (the round ended unsolved: given up, or capped) is the key SUNK — pushed into
//     the board, played out: its top stands `sinkOf(H)` rows lower (a quarter of the key) over
//     the same foot, and it is out of the light — no slate cap, no light band, bare dusk iron to
//     its top — its number kept, in the muted ink the board's over row wears, centred under
//     where its cap would stand (`numberCells(…, sink)`). No charge, no %, no heat, no cobalt,
//     no link, no foil: a door to the revealed sentence, never a day to resume — so a charged
//     key always means one. Over reads as SHAPE — a low, unlit top in a row of lit caps —
//     never by hue alone, at every size. Each picture carries its own look (`Iron.sink`,
//     `lit`, its mark): standing and lit with its white number, or sunk. Held down, it sinks a
//     row further, like any key.
//   A RUN: finished keys side by side are JOINED by the streak's edge-on link across the gap
//     (cobalt over deep), and a run carries on across a week's end — a short stub out of the
//     last key, one into the next week's first. Never foil, never called a streak (a late
//     solve joins a run here; the streak would not count it).
//   TODAY wears a WHITE cap — the key that is lit — and when it is finished it is the
//     screen's ONE shiny thing: the cobalt recedes into the FOIL, over the key's own foot.
//   A DAY TO COME is its number in slate on bare ground, no key at all; a pad is nothing.
//   A DAY NOT KNOWN YET (#211) is the key's GHOST: its shape as a slate checker round its
//     white number — no cap, no light band, so it never reads as a day not started — SPARSE
//     while the read is out (a light washing across it on the diagonal), the house's 50%
//     checker once it rests (failed, or never asked). Today's ghost keeps its white cap.
//
// THE BEATS (`keysBeats`): the month ARRIVES once per day (the screen's memory): keys dissolve
// in on the diagonal as plain iron, then the played ones CHARGE from their feet with a white
// write head — the one white the arrival spends — the finished ones locking through their caps
// and the links joining as each run closes; then TODAY FALLS into its place, eased in, lands
// with the podium's shake and, as loud as what the day holds, a white impact and a burst (a
// day never opened, or over, lands quietly); if it is finished, its cobalt recedes into the
// foil. A day that CHANGED since the month was last drawn plays its own charge (a new solve
// locks white, bursts and welds its run); a day turning OVER is PRESSED: its top drops row by
// row to its sunk height in hard frames, its number riding down with it — one number, whole,
// in the over ink from the first frame, never the old one beside it — while the iron alone
// gives way, its cap, its light and any charge going out cell by cell into the unlit face.
// A day restarted from over (a republish) charges from the sunk key, which its pre-charge
// frame shows: on the write head's first frame it is lit again and RISES back to its full
// height as its front climbs, on the charge's own easing. Then the clock rests: nothing moves
// but today's foil.

// ── The inks: the streak raster's own — the tokens, nothing else — packed for the canvas ──
const WHITE = inkAbgr(I_WHITE); // --fg: a playable number, the write head, today's cap
const MUTED = inkAbgr(I_MUTED); // --muted: the read wave's light, an over day's number
const RAIL = inkAbgr(I_RAIL); // --rail: iron's lit cap, a slate number, the ghost's checker
const COBALT = inkAbgr(I_COBALT); // --solve: a finished day
const DEEP = inkAbgr(I_DEEP); // cobalt's under-face: a finished key's foot, a link's shade
const GROUND = inkAbgr(I_GROUND); // --bg, opaque: a number cut out of its key
const DUSK = inkAbgr(I_DUSK); // iron's face, and the whole of a sunk key's

// ── The model: what each of the grid's 42 cells shows ──────────────────────────────────────
export type KeyState =
  | { kind: 'pad' }
  | { kind: 'out'; day: number } // out of the playable window: its number in slate
  | { kind: 'unknown'; day: number } // the month has not arrived
  | { kind: 'none'; day: number }
  | { kind: 'progress'; day: number; pct: number } // 1–99: 100 is only ever a solve
  | { kind: 'over'; day: number } // ended unsolved: given up, or capped
  | { kind: 'solved'; day: number };

export interface KeysModel {
  keys: readonly KeyState[];
  // Today's cell, or -1 where the month does not hold it.
  today: number;
  // The month's days are known, a read is out for them, or the read rests (failed, or never
  // asked).
  phase: 'data' | 'loading' | 'resting';
}

// A key's reading as the DRAWN memory keeps it.
export function codeOf(key: KeyState): DrawnCode | null {
  if (key.kind === 'none') return 'n';
  if (key.kind === 'over') return 'o';
  if (key.kind === 'progress') return `p${key.pct}`;
  if (key.kind === 'solved') return 's';
  return null;
}
// Over ranks with none: a day turning over is no upgrade (it dissolves), and one restarted
// from it (a republish) charges up like one never opened.
const codeRank = (code: DrawnCode) =>
  code === 's' ? 101 : code === 'n' || code === 'o' ? 0 : Number(code.slice(1));
// Only an UPGRADE gets a ceremony: more done, or done.
const isUpgrade = (from: DrawnCode, to: DrawnCode) => codeRank(to) > codeRank(from);

// ── The beats, in ms since the scene began ────────────────────────────────────────────────
// The ARRIVAL: each key dissolves in from its diagonal's beat in IN_STEPS hard steps over IN_MS
// (the podium's place); a played key charges from CHARGE_AT_MS + its beat, over its pace's
// charge; a turn's arrival runs quicker (the month already in the reader's eye). A link joins
// LINK_AFTER_MS after the later of its two keys locks. TODAY falls from DROP_LIFTS cells up, a
// frame a step, eased in, IMPACT_AT_MS into the arrival (at once on the 22:00 flip), then the
// podium's shake; its links join once it is still, and its cobalt recedes into the foil then,
// over the podium's RECEDE. A CHANGE: up to MAX_CEREMONIES days in date order, CHANGE_GAP_MS
// apart, each charging from what it said to what it says over TRAVEL_MS, a new solve's cap and
// links white for FLASH_MS; a day turning over is pressed from PRESS_AT_MS over PRESS_MS; the
// rest dissolve to their new picture. LOADING: the numbers
// dissolve in at once on the diagonal, the ghosts after the skeleton's wait (a quick read never
// flashes one); then the read wave, WAVE_FRAMES frames of WAVE_FRAME_MS, the first WAVE_LIT
// each lighting a diagonal.
const PAST = -Infinity;
const PACES = {
  arrive: { diag: 30, charge: 240 },
  turn: { diag: 20, charge: 200 },
} as const;
const IN_MS = 160;
const IN_STEPS = 6;
const CHARGE_AT_MS = 200;
const FLASH_MS = 2 * FRAME_MS;
const LINK_AFTER_MS = FRAME_MS;
const DROP_LIFTS = [10, 9, 7, 4] as const;
const FALL_MS = DROP_LIFTS.length * FRAME_MS;
const IMPACT_AT_MS = 864;
const SHAKE_MS = SHAKE.length * SHAKE_FRAME_MS;
const MAX_CEREMONIES = 3;
const CHANGE_GAP_MS = 160;
const TRAVEL_MS = 240;
const CHANGE_STEPS = 8;
// The PRESS of a day turning over: three frames standing first, so the eye has the key before
// it goes down, then six frames down, a row a frame (two on a frame or two of WIDE's deeper
// sink, one held on TINY's shallower one).
const PRESS_AT_MS = 3 * FRAME_MS;
const PRESS_MS = 6 * FRAME_MS;
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
  // White for its first two frames: a link a ceremony closes (a new solve, today's landing).
  flash: boolean;
}

export interface KeysBeats {
  // Per cell: when it starts coming in (PAST: standing) — the key in the arrival, the number
  // and the ghost while loading, a changed day's new picture.
  keyIn: number[];
  digitIn: number[];
  ghostIn: number[];
  dissolve: number[];
  // Per cell: when a day turning over starts going down (PAST: no press).
  press: number[];
  // Per cell: when its charge starts (PAST: charged), from what (a changed day's old reading;
  // null: bare iron), and — finished — when it locks through the cap, its cap white for two
  // frames first or not (`flash`: a change's ceremony; the arrival locks straight to cobalt).
  charge: number[];
  chargeMs: number;
  from: (DrawnCode | null)[];
  lock: number[];
  flash: boolean[];
  links: LinkBeat[];
  // Today's fall: its first frame and the impact (null: no drop), and whether the impact
  // flashes white (a day that holds something; a day never opened, or over, lands quietly).
  drop: number | null;
  impact: number | null;
  impactFlash: boolean;
  // Today's foil: undefined, none; null, born on (a revisit); else when the cobalt recedes.
  foil: number | null | undefined;
  // The read wave's first frame (null: none).
  wave: number | null;
  // The bursts behind the keys: today's impact (a day played), a new solve's lock.
  bursts: { index: number; at: number }[];
  // When nothing but a loop (the wave, the foil) moves any more — every burst blown out.
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
    press: past(),
    charge: past(),
    chargeMs: PACES.arrive.charge,
    from: new Array<DrawnCode | null>(n).fill(null),
    lock: past(),
    flash: new Array<boolean>(n).fill(false),
    links: [],
    drop: null,
    impact: null,
    impactFlash: false,
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
    // It falls in its landed state (a finished one locked) and lands as loud as it is full.
    b.impact = spec.drop === 'flip' ? FALL_MS : IMPACT_AT_MS;
    b.drop = b.impact - FALL_MS;
    if (solved(today)) b.lock[today] = b.drop;
    const kind = model.keys[today].kind;
    if (kind === 'progress' || kind === 'solved') {
      b.impactFlash = true;
      b.bursts.push({ index: today, at: b.impact });
    }
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
      if (key.kind === 'solved') b.lock[i] = b.charge[i] + b.chargeMs;
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
    for (const c of spec.changes) b.from[c.index] = c.from;
    ups.forEach((c, k) => {
      const i = c.index;
      b.charge[i] = k * CHANGE_GAP_MS;
      ends.push(b.charge[i] + TRAVEL_MS + FRAME_MS);
      if (solved(i)) {
        b.lock[i] = b.charge[i] + TRAVEL_MS;
        b.flash[i] = true;
        b.bursts.push({ index: i, at: b.lock[i] });
        ends.push(b.lock[i] + FLASH_MS);
      }
    });
    for (const c of spec.changes) {
      if (ups.includes(c)) continue;
      // A day turning over is pressed down; any other change dissolves to its new picture.
      if (to(c) === 'o') {
        b.press[c.index] = PRESS_AT_MS;
        ends.push(PRESS_AT_MS + PRESS_MS);
        continue;
      }
      b.dissolve[c.index] = 0;
      ends.push(DISSOLVE_MS);
    }
  }
  // The runs: a link between two finished keys of a week, a pair of stubs across its end — each
  // joining once both its keys are still (today's after its shake), white where a ceremony
  // closes it.
  const settledAt = (i: number) => (i === today && b.impact !== null ? b.impact + SHAKE_MS : b.lock[i] + LINK_AFTER_MS);
  const loud = (i: number) => b.flash[i] || (i === today && b.impact !== null);
  for (let i = 0; i < n; i += 1) {
    if (!solved(i) || !solved(i + 1)) continue;
    const at = Math.max(settledAt(i), settledAt(i + 1));
    const flash = loud(i) || loud(i + 1);
    b.links.push({ a: i, b: i + 1, wrap: i % 7 === 6, at, flash });
    ends.push(at + (flash ? FLASH_MS : 0));
  }
  if (today >= 0 && solved(today)) {
    // Today's foil comes once its moment has played: after the drop's shake, or after the lock
    // of a charge it played; a month already standing wears it from its first frame.
    b.foil =
      b.impact !== null
        ? b.impact + SHAKE_MS
        : b.lock[today] > PAST
          ? b.lock[today] + (b.flash[today] ? FLASH_MS : 0)
          : null;
    if (b.foil !== null) ends.push(b.foil + RECEDE_MS);
  }
  // A burst is up until its last frame has blown out: the scene is not settled before.
  for (const burst of b.bursts) ends.push(burst.at + BURST_ART.ms);
  b.settled = settledAfter(ends);
  return b;
}

// The beats fall between frames (a diagonal's 20 or 30ms), and a frame shows the beat its
// start has reached: the scene has settled a whole frame after its last beat ends.
const settledAfter = (ends: readonly number[]) => Math.max(...ends) + FRAME_MS;

// ── The raster ────────────────────────────────────────────────────────────────────────────
// A key's MARK on a `W` × `H` key: a glyph `w` × `h` cells read off `on`, its first cell at
// (x0, y0) — a font pixel a cell — and the cell of RING round it (its eight neighbours), where
// the hard edge stands. 1: the mark's ink; 2: its ring; 0: the key's face.
function markCells(
  W: number,
  H: number,
  mark: { w: number; h: number; on: (gx: number, gy: number) => boolean },
  x0: number,
  y0: number,
): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let gy = 0; gy < mark.h; gy += 1) {
    for (let gx = 0; gx < mark.w; gx += 1) {
      const x = x0 + gx;
      const y = y0 + gy;
      if (mark.on(gx, gy) && x >= 0 && x < W && y >= 0 && y < H) m[y * W + x] = 1;
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
  return m;
}

// HOW FAR AN OVER KEY IS SUNK: a quarter of its height — WIDE's 8 rows to TINY's and SIDEWAYS'
// 4 — deep enough to read as a key pushed down beside a standing one at every size, and
// shallow enough to leave its number, ring and all, iron over it and under it.
export const sinkOf = (H: number) => Math.round(H / 4);

// THE NUMBER: the 16px face on the type grid, centred on its ink box in the rows under the cap
// — on a key SUNK `sink` rows, in the rows under where its cap would stand, so today's white
// one never meets its ring.
const numberTop = (H: number, sink = 0) => sink + 1 + Math.floor((H - sink - 1 - COUNT_ROWS) / 2);
export function numberCells(W: number, H: number, day: number, sink = 0): Uint8Array {
  const text = String(day);
  const inkW = Math.round(inkEms(text.length) * COUNT_EM);
  const on = countInk(DIGIT_MASKS, text);
  return markCells(W, H, { w: text.length * COUNT_EM, h: COUNT_ROWS, on }, Math.floor((W - inkW) / 2), numberTop(H, sink));
}

export interface KeysScene {
  // Paint the whole frame at `t` into `px` (cols × rows, ABGR) — today's foil with it, or not
  // (the resting frame the foil is repainted over); `pressed`, the key held down (or -1);
  // `until`, for a scene another has replaced and that plays on under it: what had not begun
  // to come in by then never does (no ghost rises after the read it waited for has landed).
  draw: (px: Uint32Array, t: number, withFoil: boolean, pressed: number, until?: number) => void;
  // Repaint only the FOIL at `t` over a frame drawn at rest.
  foil: (px: Uint32Array, rest: Uint32Array, t: number, pressed: number) => void;
  foilBoxes: readonly Box[];
  settled: number;
  // What still moves once settled: the read wave, today's foil, or nothing.
  loop: 'wave' | 'foil' | null;
}

// A dissolve's level at `t` from `from`, in `steps` hard steps over `ms` (1: whole).
const level = (from: number, ms: number, steps: number, ft: number) =>
  from === PAST ? 1 : Math.ceil(clamp01((ft - from) / ms) * steps) / steps;

// One key as it stands at a frame: the charge's front (rows inked from the foot) and the row
// its number is split at, its ink, a flat fill (a finished charge) or the ramp, the write
// head's row, and the cap — its LOOK: how many rows it is sunk (`sink`: its top row; 0, a key
// standing) and whether it is in the light (`lit`: the slate cap and the light band; a sunk
// over key is not) — and its MARK: the cells of its number where that look stands them and
// the number's ink above the edge. Each picture carries its own, so a day changing kind
// dissolves from its old look to its new one. A key being PRESSED carries what it is going
// down out of (`press`): the iron it stood as (`from`, whose CHARGE alone is read: never its
// number, never its light), how much of that charge has gone out (`fade`, a dissolve level),
// and how much light its top still catches (`light`, 1 standing to 0 sunk).
interface Iron {
  front: number;
  split: number;
  fill: number;
  flat: boolean;
  head: number;
  locked: boolean;
  capFlash: boolean;
  todayCap: boolean;
  sink: number;
  lit: boolean;
  glyph: Uint8Array;
  ink: number;
  press?: { from: Iron; fade: number; light: number };
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
  const corner = (lx: number, ly: number) => (lx === 0 || lx === W - 1) && (ly === 0 || ly === H - 1);
  // A key's cells from its top row `top` down: a SUNK key's starts that many rows lower, and a
  // key held down has lost its top row besides — its new top row wears the cut corners.
  const shape = (lx: number, ly: number, top: number) =>
    ly >= top && !((lx === 0 || lx === W - 1) && (ly === top || ly === H - 1));
  const SINK = sinkOf(H);
  // Rows under the cap; the charge's least and most front (a solid foot row; never the iron's
  // top four rows), and a finished charge's, through the cap.
  const n = H - 1;
  const frontOf = (pct: number) => (pct <= 0 ? 0 : Math.min(n - 4, Math.max(3, (pct / 100) * n)));
  const FULL = H;
  const heats = new Map<number, number>();
  const heat = (pct: number) => {
    let v = heats.get(pct);
    if (v === undefined) {
      v = rgbToAbgr(progressHeatColor(pct));
      heats.set(pct, v);
    }
    return v;
  };

  // THE NUMBER's cells (`numberCells`), worked out once per day number and kept; its top row.
  const y0 = numberTop(H);
  // A finished key's foot: its lower half falls into the deep, row by row, its last row whole —
  // but never in the number's band (its rows and its ring's), which stays solid cobalt round
  // the cut-out digits: under the ring the ramp picks up at the density it has there.
  const footFrom = Math.floor(H / 2);
  const footDeep = (lx: number, ly: number) =>
    ly === H - 1 ||
    (ly > y0 + COUNT_ROWS && ly >= footFrom && bayerThreshold(lx, ly) < (ly - footFrom) / (H - 1 - footFrom));
  const maps = new Map<number, Uint8Array>();
  const digitMap = (day: number, sink = 0) => {
    const key = day * 64 + sink;
    let m = maps.get(key);
    if (!m) {
      m = numberCells(W, H, day, sink);
      maps.set(key, m);
    }
    return m;
  };
  // A picture's LOOK and MARK: an over day SUNK out of the light, its number muted; any other
  // standing and lit, its number white.
  const lookOf = (over: boolean, day: number) =>
    over
      ? { sink: SINK, lit: false, glyph: digitMap(day, SINK), ink: MUTED }
      : { sink: 0, lit: true, glyph: digitMap(day), ink: WHITE };
  // THE NUMBER'S EDGE: the first of its rows the ink takes (cut out from there down), off the
  // front — moved to the nearest row that leaves three or more of its rows on each side, or
  // none: a number split one or two rows from its end reads as two broken glyphs.
  const splitOf = (front: number) => {
    let inked = 0;
    for (let r = 0; r < COUNT_ROWS; r += 1) if (H - 1 - (y0 + r) < front - 1.5) inked += 1;
    if (inked < 3) inked = inked <= 1 ? 0 : 3;
    else if (inked > COUNT_ROWS - 3) inked = inked >= COUNT_ROWS - 1 ? COUNT_ROWS : COUNT_ROWS - 3;
    return y0 + COUNT_ROWS - inked;
  };
  // …AND THE FRONT AGREES WITH IT where it can. The edge is the %'s (`splitOf(raw)`), never the
  // digit's: the ramp's front (`raw`) moves to the nearest place at most EDGE_REACH rows away,
  // inside [3, n − 4] (a charge's own front where it is still under 3), that splits the number
  // at that same edge and where no ring cell disagrees with its row's ramp — an ink ring only on
  // a row a third inked or more, a dusk ring only on a row under two thirds. So no ink HAT
  // stands over a number, and no dusk NOTCH in the ink. Read on the row as it shows: its face
  // cells (outside the number and its ring), a row with under four of them saying nothing.
  // Where nothing that close agrees, the front stays where its % puts it, hat or notch and all:
  // the height is the reading. (On the smallest keys a whole number's top ring stands over the
  // highest front a day under 100 reaches, so a number cut out whole there wears its hat.) The
  // places are eighths of a row on one grid, the same for every front, so a higher % never
  // stands lower.
  const EDGE_STEP = 1 / 8;
  const EDGE_REACH = 2;
  const edges = new Map<string, { front: number; split: number }>();
  const edgeOf = (raw: number, day: number) => {
    const known = edges.get(`${day}|${raw}`);
    if (known) return known;
    const dmap = digitMap(day);
    const split = splitOf(raw);
    const agrees = (front: number) => {
      if (splitOf(front) !== split) return false;
      for (let ly = y0 - 1; ly <= y0 + COUNT_ROWS; ly += 1) {
        const density = rampDensity(front, H - 1 - ly, 3);
        let ring = false;
        let face = 0;
        let inked = 0;
        for (let lx = 0; lx < W; lx += 1) {
          const dc = dmap[ly * W + lx];
          if (dc === 2) ring = true;
          else if (dc === 0 && !corner(lx, ly)) {
            face += 1;
            if (bayerThreshold(lx, ly) < density) inked += 1;
          }
        }
        if (!ring || face < 4) continue;
        const ink = Math.min(Math.max(ly, y0), y0 + COUNT_ROWS - 1) >= split;
        if (ink ? inked / face < 1 / 3 : inked / face >= 2 / 3) return false;
      }
      return true;
    };
    const lo = Math.max(Math.min(3, raw), raw - EDGE_REACH);
    const hi = Math.min(n - 4, raw + EDGE_REACH);
    let front = raw;
    // The grid's places, nearest `raw` first, the higher of two as near.
    let up = Math.ceil(raw / EDGE_STEP);
    let down = up - 1;
    while (raw > 0) {
      const takeUp = up * EDGE_STEP - raw <= raw - down * EDGE_STEP;
      const at = (takeUp ? up : down) * EDGE_STEP;
      if (Math.abs(at - raw) > EDGE_REACH) break;
      if (takeUp) up += 1;
      else down -= 1;
      if (at >= lo && at <= hi && agrees(at)) {
        front = at;
        break;
      }
    }
    const edge = { front, split };
    edges.set(`${day}|${raw}`, edge);
    return edge;
  };

  // (Only a day's key is ever iron: a pad's number is never asked for.)
  const dayOf = (i: number) => {
    const key = model.keys[i];
    return key.kind === 'pad' ? 0 : key.day;
  };
  // A key's front and its number's edge off the front `raw`: agreeing (`edgeOf`) on a ramp of
  // ink, as they stand on a FLAT fill (a finished charge, solid to its front) — and the look
  // and mark of what it says now. (Every front above 0 belongs to a standing picture: an over
  // day's is 0, so its edge never splits its number.)
  const ironAt = (raw: number, fill: number, i: number, flat: boolean): Iron => {
    const day = dayOf(i);
    const { front, split } = flat ? { front: raw, split: splitOf(raw) } : edgeOf(raw, day);
    return {
      front,
      split,
      fill,
      flat,
      head: -1,
      locked: false,
      capFlash: false,
      todayCap: i === model.today,
      ...lookOf(model.keys[i].kind === 'over', day),
    };
  };
  // A played key's front and ink as it said `code` (a changed day's reading before its change).
  const readingOf = (code: DrawnCode | null) =>
    code === null || code === 'n' || code === 'o'
      ? { front: 0, fill: 0 }
      : code === 's'
        ? { front: FULL, fill: COBALT }
        : { front: frontOf(Number(code.slice(1))), fill: heat(Number(code.slice(1))) };
  // …and the picture it was drawn as, with ITS look: a day turning over gives way from its
  // standing key, a day restarted from over charges from its sunk one.
  const wasOf = (i: number): Iron => {
    const was = readingOf(tl.from[i]);
    const done = tl.from[i] === 's';
    return { ...ironAt(was.front, was.fill, i, done), locked: done, ...lookOf(tl.from[i] === 'o', dayOf(i)) };
  };

  const ironOf = (i: number, ft: number): Iron => {
    const key = model.keys[i];
    const done = key.kind === 'solved';
    const front = done ? FULL : key.kind === 'progress' ? frontOf(key.pct) : 0;
    const fill = done ? COBALT : key.kind === 'progress' ? heat(key.pct) : 0;
    const iron = ironAt(front, fill, i, done);
    const p0 = tl.press[i];
    if (ft < p0 + PRESS_MS) {
      // TURNING OVER, PRESSED: standing as it was until the press, then its top a row lower a
      // frame (`sink`), the number with it where that top stands it — the over look's, whole,
      // from the first frame — its top going down out of the light (its cap and light band
      // thinning as it sinks), its charge staying at its foot and going out cell by cell.
      if (ft < p0) return wasOf(i);
      const sink = Math.ceil(SINK * clamp01((ft - p0) / PRESS_MS));
      iron.sink = sink;
      iron.glyph = digitMap(dayOf(i), sink);
      iron.press = { from: wasOf(i), fade: level(p0, PRESS_MS, CHANGE_STEPS, ft), light: 1 - sink / SINK };
      return iron;
    }
    const lock = tl.lock[i];
    if (done && ft >= lock + (tl.flash[i] ? FLASH_MS : 0)) {
      iron.locked = true;
      return iron;
    }
    const c0 = tl.charge[i];
    // (A ceremony is an upgrade: what it charges from is never a finished key.)
    if (ft < c0) return wasOf(i);
    const end = c0 + tl.chargeMs;
    if (ft < end) {
      // Rising, eased out, its top row the white write head — the front and the number's edge
      // agreeing on every frame as at rest, so its last frame is the resting one.
      const f0 = readingOf(tl.from[i]).front;
      const p = easeOut((ft - c0) / tl.chargeMs);
      const rising = ironAt(f0 + (front - f0) * p, fill, i, done);
      rising.head = Math.ceil(rising.front) - 1;
      // A key restarted from over is lit again and RISES out of the board on the same easing.
      if (tl.from[i] === 'o') rising.sink = Math.round(SINK * (1 - p));
      return rising;
    }
    if (done) {
      // A ceremony's lock: through the cap, the cap white for two frames.
      iron.capFlash = true;
      return iron;
    }
    // The head takes its ink one frame after the front stops.
    if (ft < end + FRAME_MS) iron.head = Math.ceil(iron.front) - 1;
    return iron;
  };

  // Its TOP's light, on the key's own rows from its top (`r`), so it rides a key that moves:
  // the slate cap, its light dithered into the dusk face — as much as it catches (`light`: 1
  // standing, thinning in the Bayer order as a pressed key goes down).
  const topLit = (lx: number, r: number, light = 1) =>
    r === 0 ? bayerThreshold(lx, r) < light : r === 1 ? bayerThreshold(lx, r) < 0.5 * light : r === 2 && bayerThreshold(lx, r) < 0.2 * light;

  // A cell of an iron key (`dc`: its mark's ink 1, its ring 2) — `r`, its row from the key's
  // own top, where a sunk key's caps stand.
  const ironPixel = (k: Iron, lx: number, ly: number, dc: number): number => {
    const u = H - 1 - ly;
    const r = ly - k.sink;
    if (k.locked) {
      if (dc === 1) return GROUND;
      if (dc === 2) return COBALT;
      if (k.todayCap && r <= 1) return WHITE;
      return footDeep(lx, ly) ? DEEP : COBALT;
    }
    // THE HARD EDGE: the number and its ring read the split, never the dither (a ring cell over
    // or under the number reads the number's nearest row). Above it the mark is its own ink.
    if (dc !== 0) {
      const inked = Math.min(Math.max(ly, y0), y0 + COUNT_ROWS - 1) >= k.split;
      if (dc === 1) return inked ? GROUND : k.ink;
      return inked ? k.fill : DUSK;
    }
    if (u === k.head) return WHITE;
    if (r === 0 && k.capFlash) return WHITE;
    if (r <= 1 && k.todayCap) return WHITE;
    if (k.front > 0 && u < k.front) {
      if (k.flat || bayerThreshold(lx, ly) < rampDensity(k.front, u, 3)) return k.fill;
    }
    // Bare iron, lit from above — or, sunk into the board, out of the light: dusk to its top.
    return k.lit && topLit(lx, r) ? RAIL : DUSK;
  };

  // A face cell of a key being PRESSED (`k.press`; its number and ring are `ironPixel`'s): the
  // charge it stood with, at its foot, until the Bayer order (on the screen's cells: the charge
  // does not move) takes it out; else its top going down out of the light — today's white cap
  // riding it — over the unlit dusk.
  const pressPixel = (k: Iron, lx: number, ly: number, X: number, Y: number): number => {
    const { from, fade, light } = k.press!;
    if (bayerThreshold(X, Y) >= fade) {
      const was = ironPixel(from, lx, ly, 0);
      if (was !== RAIL && was !== DUSK && was !== WHITE) return was;
    }
    const r = ly - k.sink;
    if (r <= 1 && k.todayCap) return WHITE;
    return topLit(lx, r, light) ? RAIL : DUSK;
  };

  // The read wave's light on diagonal `d` at a frame: 1 lit, 0.5 half-lit, 0 dark.
  const waveOn = (d: number, ft: number) => {
    if (tl.wave === null || ft < tl.wave) return 0;
    const f = Math.floor((ft - tl.wave) / WAVE_FRAME_MS) % WAVE_FRAMES;
    if (f >= WAVE_LIT) return 0;
    return d === f ? 1 : d === f - 1 ? 0.5 : 0;
  };
  // A cell of a ghost: its number white in a clearing, its shape a slate checker — sparse while
  // a read is out, the house's 50% at rest — and today's white cap over it.
  const ghostPixel = (lx: number, ly: number, dc: number, lit: number, isToday: boolean): number => {
    if (dc === 1) return WHITE;
    if (dc === 2) return GROUND;
    if (corner(lx, ly)) return 0;
    if (isToday && ly <= 1) return WHITE;
    const th = bayerThreshold(lx, ly);
    const on = model.phase === 'loading' ? th < SPARSE : ((lx + ly) & 1) === 0;
    if (!on) return 0;
    if (lit === 1 || (lit === 0.5 && th < SPARSE / 2)) return MUTED;
    return RAIL;
  };

  const drawKey = (px: Uint32Array, i: number, ft: number, pressed: number, until: number) => {
    const key = model.keys[i];
    if (key.kind === 'pad') return;
    const { x, y } = keyAt(G, i);
    // The number's cells, for the kinds drawn without iron (a day out of range, a ghost); an
    // iron key reads its picture's own mark.
    const dmap = digitMap(key.day);
    const isToday = i === model.today;

    let dx = 0;
    let dy = 0;
    if (isToday && tl.drop !== null && tl.impact !== null) {
      // TODAY FALLS: held back as bare ground — whatever stood there before is gone — until it
      // falls, a frame a step, eased in; then it lands and shakes.
      if (ft < tl.drop) return;
      if (ft < tl.impact) dy = -DROP_LIFTS[Math.floor((ft - tl.drop) / FRAME_MS)];
      else if (ft < tl.impact + SHAKE_MS) [dx, dy] = SHAKE[Math.floor((ft - tl.impact) / SHAKE_FRAME_MS)];
    }
    const struck = isToday && tl.impactFlash && tl.impact !== null && ft >= tl.impact && ft < tl.impact + FRAME_MS;
    const down = i === pressed && key.kind !== 'out' ? 1 : 0;
    // (A beat that had not begun when this scene was replaced never begins.)
    const begun = (beat: number) => (beat > until ? Infinity : beat);
    const lvIn = Math.min(
      level(tl.keyIn[i], IN_MS, IN_STEPS, ft),
      level(tl.dissolve[i], DISSOLVE_MS, CHANGE_STEPS, ft),
    );
    const lvDigit = model.phase === 'data' ? lvIn : level(begun(tl.digitIn[i]), IN_MS, IN_STEPS, ft);
    const lvGhost = level(begun(tl.ghostIn[i]), IN_MS, IN_STEPS, ft);
    const iron =
      key.kind === 'none' || key.kind === 'over' || key.kind === 'progress' || key.kind === 'solved'
        ? ironOf(i, ft)
        : null;
    // A changed day with no frame before it on screen (the screen opened on it) gives way from
    // its old reading.
    const was = !under && iron && tl.from[i] !== null ? wasOf(i) : null;
    const lit = key.kind === 'unknown' ? waveOn(diagOf(i), ft) : 0;
    // (Offsets only once the key has come in whole: what gives way gives way where it stood.)
    const arriving = lvIn < 1 || lvDigit < 1;
    if (arriving) dx = dy = 0;
    for (let ly = 0; ly < H; ly += 1) {
      for (let lx = 0; lx < W; lx += 1) {
        const X = x + lx;
        const Y = y + ly;
        const dc = dmap[ly * W + lx];
        const lv = key.kind === 'unknown' ? (dc === 1 ? lvDigit : lvGhost) : key.kind === 'out' ? lvDigit : lvIn;
        if (lv < 1 && bayerThreshold(X, Y) >= lv) {
          if (under) put(px, X, Y, under[Y * cols + X]);
          else if (was && shape(lx, ly, was.sink)) put(px, X, Y, ironPixel(was, lx, ly, was.glyph[ly * W + lx]));
          continue;
        }
        let v = 0;
        if (key.kind === 'out') v = dc === 1 ? RAIL : 0;
        else if (key.kind === 'unknown') v = ghostPixel(lx, ly, dc, lit, isToday);
        else if (iron && shape(lx, ly, iron.sink + down)) {
          const mark = iron.glyph[ly * W + lx];
          v = struck ? WHITE : iron.press && mark === 0 ? pressPixel(iron, lx, ly, X, Y) : ironPixel(iron, lx, ly, mark);
        }
        if (v !== 0) put(px, X + dx, Y + dy + down, v);
      }
    }
  };

  // A LINK between two finished keys of a week — the streak's edge-on bar across the gap, its
  // lit face over its under-face — or a WRAP's two short stubs, out into the bleed and in from
  // it, ending square. A link follows a key held down; a ceremony's stamps white two frames.
  const linkMid = Math.floor(H / 2);
  const linkInk = (row: number, white: boolean) => (white ? WHITE : row < linkMid ? COBALT : DEEP);
  const STUB = 2;
  const drawLink = (px: Uint32Array, link: LinkBeat, ft: number, pressed: number) => {
    if (ft < link.at) return;
    const white = link.flash && ft < link.at + FLASH_MS;
    const a = keyAt(G, link.a);
    const b = keyAt(G, link.b);
    const downA = link.a === pressed ? 1 : 0;
    const downB = link.b === pressed ? 1 : 0;
    for (let r = linkMid - 2; r <= linkMid + 1; r += 1) {
      if (!link.wrap) {
        for (let x = a.x + W; x < b.x; x += 1) put(px, x, a.y + r + Math.max(downA, downB), linkInk(r, white));
        continue;
      }
      for (let j = 0; j < STUB; j += 1) {
        put(px, a.x + W + j, a.y + r + downA, linkInk(r, white));
        put(px, b.x - 1 - j, b.y + r + downB, linkInk(r, white));
      }
    }
  };

  // TODAY'S FOIL: the shared material over its key's shape — its number still cut out, its
  // deep foot kept, so it is the same key turned to foil — the cobalt receding into it cell by
  // cell in the Bayer order, then glitter once it is whole.
  const today = model.today;
  const foilOn = today >= 0 && tl.foil !== undefined && model.keys[today]?.kind === 'solved';
  const foilBoxes: Box[] = foilOn ? [{ ...keyAt(G, today), w: W, h: H + 1 }] : [];
  const paintFoil = (px: Uint32Array, t: number, pressed: number) => {
    const from = tl.foil;
    if (!foilOn || from === undefined) return;
    const ft = framed(t);
    if (from !== null && ft < from) return;
    const key = model.keys[today];
    if (key.kind === 'pad') return;
    const { x, y } = keyAt(G, today);
    const down = pressed === today ? 1 : 0;
    const dmap = digitMap(key.day);
    // (Asked at a cell's centre.)
    const inside = (cx: number, cy: number) => {
      const lx = Math.floor(cx);
      const ly = Math.floor(cy);
      return lx >= 0 && ly >= 0 && lx < W && ly < H && shape(lx, ly, down) && dmap[ly * W + lx] !== 1 && !footDeep(lx, ly);
    };
    const solid = from === null ? 0 : recedeLevel(ft, from);
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

  const draw = (px: Uint32Array, t: number, withFoil: boolean, pressed: number, until = Infinity) => {
    px.fill(0);
    const ft = framed(t);
    if (model.phase === 'data') for (const link of tl.links) drawLink(px, link, ft, pressed);
    for (let i = 0; i < model.keys.length; i += 1) drawKey(px, i, ft, pressed, until);
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
