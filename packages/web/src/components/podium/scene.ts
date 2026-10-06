import {
  COUNT_EM,
  COUNT_ROWS,
  DIGIT_MASKS,
  FOIL_WHITE,
  SPARKLE_SHARE,
  UI_ADVANCE_EM,
  bayerThreshold,
  countInk,
  foilCells,
  foilGlitter,
  foilInkRgb,
  heatCells,
  heatKeepOut,
  inkEms,
  progressHeatColor,
  reelInk,
  reelRow,
  type HeatKeep,
} from '@whippin/shared';
import { stepTier } from '../../game/podium';
import { DISSOLVE_MS, SKELETON_WAIT_MS } from '../bayerTiles';
import { LINE_PX } from '../boardMetrics';
import { runEnd, runReel } from '../countRun';
import { abgr, rgbToAbgr } from '../raster';
import {
  COBALT as I_COBALT,
  DUSK as I_DUSK,
  MUTED as I_MUTED,
  RAIL as I_RAIL,
  WHITE as I_WHITE,
  inkAbgr,
} from '../streak/sprites';

// THE PODIUM SCENE (the board's subject, the way the result has its count): the day's — or
// the period's — top three standing on a stepped PODIUM, drawn as the streak celebration draws
// its orbit: ONE raster of whole cells on the bare ground (the house's 2px cell, a canvas pixel
// each, scaled up `pixelated`), in the app's inks and nothing else, deterministic in `t` — the
// time since the scene began — so a frame is the same on every device and reduced motion is
// one `t` held.
//
//   THE STEPS: three plinths of iron (the chain's unlit `--rail` on its dusk face), second on
//     the left, first in the middle and widest, third on the right — each as tall as its
//     place's RANK (a tie for first stands two firsts equally tall) — on a stippled floor, the
//     result's rail. ON EACH STEP'S FACE, ITS PLACE, the way every podium says it: the crown
//     (the lines' own first-place glyph, `assets/icons/board.svg`, in the trophy cobalt) on a
//     first's, the 2 and the 3 in the pixel face's own digits on the others (the lines' quiet
//     ink, the accent on the reader's own) — each cut out of the face's dither by a cell of
//     outline. A number on a step is always a place.
//   THE VALUES under the floor, in each player's CAPTION (the DOM's name over it, its unit under
//     it): the tries, or a period's points, in the pixel face's digits — LANDING ON THE COUNT'S
//     REELS (`countRun.ts`, the board's compressed run: every reel spinning from almost the same
//     instant, stopping left to right with a whole-font-pixel shake), the others in white at
//     the lines' 16px, FIRST PLACE'S at the largest whole size that fits (its neighbours'
//     slack included: the winner's number is never the smallest-looking), in the trophy COBALT
//     — and as its last reel's shake plays out the cobalt RECEDES INTO THE HOLOGRAPHIC FOIL
//     (shared `foil.ts`), cell by cell in the Bayer order: the result's own count, landing the
//     result's own way. The foil is the scene's one shiny thing, and only its sheen and its
//     glitter move on it, both inside the digits' own ink: the result count's GLINTS stand
//     across a number's edge, and on a count this size a cross on a corner reads as a `+`.
//     Tied firsts are ONE material — one field over both numbers, one sheen crossing them.
//   THE HEAT rising off each step behind its player (shared `runHeat.ts`'s field), in the ink of
//     how close that place is to the best (`game/podium.ts` `near`: the first is the calm
//     cobalt), the players standing in a CLEARING of it (shared `heatKeepOut`).
// The MARKS are the players' avatars (`Avatar`, DOM over the raster, at 10 cells of a whole px),
// placed where `layout` says and moved by `markAt` on the same clock.
//
// FOUR PICTURES, one box (`PodiumMode`), so a state never passes for another: a read still out
// draws the FLOOR and, if it is slow, the skeleton's own rails where the names will stand (the
// lines' skeleton under it says the same, on the same beat); a FAILED one holds that picture
// still — the floor, its caption's line standing where the rails would, RETRY under it, and
// the read asked again stands its rails at once where the line stood; a board with nobody on
// it to stand (no group, a group of one, a
// period nobody scored in) draws the steps' GHOST — their silhouettes in the floor's stipple —
// for the board's sad ghost to stand on; and a board draws its steps, with whoever finished on
// them — none yet is the steps alone, each place's value a quiet dash.
//
// THE BUILD (`beats`), the first time a board is shown in the day: the steps RISE off the floor
// a whole cell row at a time (third, second, first; steps already standing — the screen turned
// from a board that had them — stay standing) and their places dissolve onto them; each player
// DROPS onto their step under gravity in whole cells and lands with a shake (and the strike
// sheet's burst, the DOM's) — a player who already stood on that place STAYS, and only their
// value runs again if it changed; each value runs on its reels from its player's landing; the
// heat SURGES as the winner lands and the crown flashes white on the impact; the lines under
// it start once that impact has played (an arrival), or at once (a turn: the steps stand, and
// the lines give way with the podium). A board already shown today is SETTLED from its
// first frame. Either way the scene before it gives way cell by cell (the component's
// cross-dissolve). Then it is still but for the foil.

// The house's cell, in CSS px: a raster pixel.
export const CELL_PX = 2;
// The podium's box is whole slots of the lines' pitch, so a column that scrolls it away rests
// on whole lines.
const SLOT_CELLS = LINE_PX / CELL_PX;

// ── The inks: the streak raster's own — the tokens, nothing else — packed for the canvas ──
const WHITE = inkAbgr(I_WHITE); // --fg
const MUTED = inkAbgr(I_MUTED); // --muted: the lines' ranks
const RAIL = inkAbgr(I_RAIL); // --rail: iron
const DUSK = inkAbgr(I_DUSK); // --surface-hover: iron's face
const COBALT = inkAbgr(I_COBALT); // --accent / --solve: the trophy, and you

// ── The crown: `assets/icons/board.svg`, the header's own board mark, traced (rows 1–9 of
// its 10×10 grid — a redrawn icon is traced again) ────────────────────────────────────────
const CROWN = [
  '....##....',
  '#...##...#',
  '##..##..##',
  '###.##.###',
  '##########',
  '##########',
  '..........',
  '##########',
  '##########',
];
const CROWN_W = CROWN[0].length;
const CROWN_H = CROWN.length;
const crownInk = (x: number, y: number) => CROWN[y]?.[x] === '#';

// ── Where everything stands, in CELLS ─────────────────────────────────────────────────────
// Two sizes (`PodiumSize`), chosen off the room the screen measures (`podiumSize`): ROOMY, and
// COMPACT where the lines under the scene need the room — or no podium at all where even the
// compact one would leave the lines no room. Each is the steps' widths (the middle one wider),
// the three tiers' heights, the marks (first place's larger — every mark 10 avatar cells of a
// whole px), the places' font pixel, a first's value's largest font pixel, the heat's least
// room over the winner's head, the CAPTION BLOCK under the names (a value and its unit) and the
// foot.
interface Dims {
  wide: number;
  narrow: number;
  gap: number;
  tiers: readonly [number, number, number];
  mark1: number;
  mark: number;
  glyph: number;
  value: number;
  air: number;
  block: number;
  bottom: number;
}
export type PodiumSize = 'roomy' | 'compact';
const SIZES: Record<PodiumSize, Dims> = {
  roomy: { wide: 58, narrow: 50, gap: 1, tiers: [32, 26, 21], mark1: 30, mark: 20, glyph: 2, value: 3, air: 10, block: 34, bottom: 1 },
  compact: { wide: 50, narrow: 44, gap: 1, tiers: [24, 19, 15], mark1: 25, mark: 20, glyph: 1, value: 2, air: 8, block: 27, bottom: 1 },
};
// Under the floor, every place's CAPTION: a gap of bare ground, the NAME's band (the DOM's: two
// 13px lines and 3px of air over and under them — a name wraps rather than being
// cut, and the band holds two lines whatever it holds, so nothing under it moves), a gap, then
// the block: the VALUE's row, a gap, the UNIT's line (the DOM's, 12px).
const NAME_GAP = 6;
export const NAME_ROWS = 16;
const VALUE_GAP = 2;
const UNIT_GAP = 2;
const UNIT_ROWS = 6;
// The step's top LIP (the iron's lit face), in rows.
const LIP = 2;
// How far a step's heat spills past its sides (cells), and the bare ground kept beyond that at
// the column's edges.
const SPILL = 3;
const EDGE = 2;
// A caption keeps this much bare ground inside each side of its slot: neighbouring names never
// run together.
const GUTTER = 2;
// A first's value keeps this much bare ground from whatever stands beside it — the slot's edge
// for two tied firsts (side by side, their foils must never read as one number), else its
// neighbours' footprints: their value, and the widest a unit runs.
const VALUE_MARGIN = 6;
const UNIT_FOOT = 24;
// The rooms the screen weighs the sizes by: the podium, the list's header and at least this
// many lines under them (one line of hysteresis, so a phone's toolbar never flips a size).
const ROOMY_LINES = 4;
const COMPACT_LINES = 2;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// One of the three places: its step, its mark at rest, its place glyph's box, its value's
// row and the slot its caption owns.
interface PlaceLayout {
  step: Box;
  mark: Box;
  place: Box; // the crown, or the 2 or 3, on the step's face
  tier: 0 | 1 | 2;
  slot: { x: number; w: number }; // the caption's share of the line, centred on the step
  value: Box; // the value's digits — or, the place unheld, its dash
  vpx: number; // cells a font pixel of the value
  unit: number; // the unit line's top row
}

export interface PodiumLayout {
  cols: number;
  rows: number;
  floor: number; // the floor's row: the steps stand on it
  compact: boolean;
  glyph: number;
  name: number; // the name band's top row
  places: [PlaceLayout, PlaceLayout, PlaceLayout];
}

// The slot each place stands in, left to right: second, first, third.
const SLOT_OF = [1, 0, 2] as const;

// A number's ink width in cells at a font pixel of `fpx` cells.
const digitsW = (value: number, fpx: number) => Math.round(inkEms(String(value).length) * COUNT_EM * fpx);

// The rows a scene's content needs, top of the heat to the foot.
const contentRows = (d: Dims) => d.air + d.mark1 + d.tiers[0] + 1 + NAME_GAP + NAME_ROWS + VALUE_GAP + d.block + d.bottom;
const slotsOf = (size: PodiumSize) => Math.ceil(contentRows(SIZES[size]) / SLOT_CELLS);
// The cells a size's steps take across, their heat and the column's edge included.
const spanOf = (d: Dims) => d.narrow + d.gap + d.wide + d.gap + d.narrow + 2 * (SPILL + EDGE);

// A size's dims in `cols` cells: its own — or, on a column narrower than its steps, the steps
// narrowed alike until they fit (never under a mark and its lip).
function dimsFor(size: PodiumSize, cols: number): Dims {
  const d = SIZES[size];
  const over = spanOf(d) - cols;
  if (over <= 0) return d;
  const k = Math.min(Math.ceil(over / 3), d.narrow - d.mark - 4);
  return { ...d, wide: d.wide - k, narrow: d.narrow - k };
}

// THE BOX'S HEIGHT in CSS px — the same on every board and in every state, whole slots of the
// lines' pitch (the padding goes to the heat's room on top).
export function podiumHeightPx(size: PodiumSize): number {
  return slotsOf(size) * LINE_PX;
}

// WHICH SIZE a column `widthPx` wide with `slots` whole lines of room stands — `was` the size it
// stood at (a size it has keeps one line's grace): ROOMY where its steps fit across and it leaves
// the header and ROOMY_LINES lines, COMPACT where it leaves the header and COMPACT_LINES, else
// none (the lines start at the first, crowned, in the result's dress).
export function podiumSize(widthPx: number, slots: number, was: PodiumSize | null): PodiumSize | null {
  const cols = Math.floor(widthPx / CELL_PX);
  const leaves = (size: PodiumSize, lines: number) => slots - slotsOf(size) - 1 >= lines - (was === size ? 1 : 0);
  if (cols >= spanOf(SIZES.roomy) && leaves('roomy', ROOMY_LINES)) return 'roomy';
  if (leaves('compact', COMPACT_LINES)) return 'compact';
  return null;
}

// `ranks`: each place's rank (null for a place nobody holds — it stands at its own place's
// tier); `values`, the numbers its captions carry (a first place's size follows its digits).
export function layout(
  widthPx: number,
  size: PodiumSize,
  ranks: readonly (number | null)[],
  values: readonly (number | null)[],
): PodiumLayout {
  const cols = Math.floor(widthPx / CELL_PX);
  const d = dimsFor(size, cols);
  const rows = podiumHeightPx(size) / CELL_PX;
  const floor = rows - (contentRows(d) - d.air - d.mark1 - d.tiers[0]);
  const name = floor + 1 + NAME_GAP;
  const valueY = name + NAME_ROWS + VALUE_GAP;
  const tiers = ranks.map((rank, p) => (rank === null ? (p as 0 | 1 | 2) : stepTier(rank)));
  const firsts = [0, 1, 2].filter((p) => tiers[p] === 0 && ranks[p] !== null);
  const tied = firsts.length > 1;
  // The steps' widths by slot (second, first, third) — tied firsts on steps of ONE width, their
  // widths' mean (a tie that stood on a wider and a narrower step would read unequal).
  const widths = [d.narrow, d.wide, d.narrow];
  if (tied) {
    const slots = firsts.map((p) => SLOT_OF[p]);
    const mean = Math.floor(slots.reduce((sum: number, slot) => sum + widths[slot], 0) / slots.length);
    for (const slot of slots) widths[slot] = mean;
  }
  const total = widths[0] + d.gap + widths[1] + d.gap + widths[2];
  const x0 = Math.floor((cols - total) / 2);
  const slotX = [x0, x0 + widths[0] + d.gap, x0 + widths[0] + d.gap + widths[1] + d.gap];
  // A caption's slot: the pitch between neighbouring steps' centres, centred on its own and
  // kept inside the column — so the three never overlap — less its gutters.
  const pitch = Math.floor((d.narrow + d.wide) / 2) + d.gap;
  // What stands under each place's name besides a first's value: its value at the lines' size
  // (or its dash), and the widest its unit runs.
  const foot = values.map((v) => Math.max(v === null ? 6 : digitsW(v, 1), UNIT_FOOT));
  const below = UNIT_GAP + UNIT_ROWS;
  const place = (p: number): PlaceLayout => {
    const slot = SLOT_OF[p];
    const tier = tiers[p];
    const w = widths[slot];
    const h = d.tiers[tier];
    const step = { x: slotX[slot], y: floor - h, w, h };
    const size = tier === 0 ? d.mark1 : d.mark;
    const mark = { x: step.x + Math.floor((w - size) / 2), y: step.y - size, w: size, h: size };
    // The place glyph, centred across the face and down its flat band (under the lip, over
    // the foot).
    const gw = tier === 0 ? CROWN_W * d.glyph : digitsW(tier + 1, d.glyph);
    const gh = tier === 0 ? CROWN_H * d.glyph : COUNT_ROWS * d.glyph;
    const faceH = h - LIP - footRows(h);
    const glyphBox = {
      x: step.x + Math.floor((w - gw) / 2),
      y: step.y + LIP + Math.max(1, Math.floor((faceH - gh) / 2)),
      w: gw,
      h: gh,
    };
    const centre = step.x + w / 2;
    const left = Math.max(0, Math.round(centre - pitch / 2));
    const right = Math.min(cols, Math.round(centre + pitch / 2));
    const slotBox = { x: left + GUTTER, w: right - left - 2 * GUTTER };
    const v = values[p] ?? null;
    // A first place's value at its largest font pixel that leaves its block its unit, and
    // leaves bare ground to its slot's edges (a tie) or to its neighbours'
    // footprints — else the others' one (the lines' 16px).
    let vpx = 1;
    if (tier === 0 && v !== null) {
      const others = [0, 1, 2].filter((q) => q !== p).map((q) => foot[q]);
      const room = tied ? pitch - 2 * VALUE_MARGIN : 2 * pitch - Math.max(...others) - 2 * VALUE_MARGIN;
      for (let f = d.value; f > 1 && vpx === 1; f -= 1) {
        if (digitsW(v, f) <= Math.min(room, cols - 2 * EDGE) && COUNT_ROWS * f + below <= d.block) vpx = f;
      }
    }
    // A place nobody holds keeps its value's row for a DASH: the pixel face's own, 6 × 2 cells
    // on the digits' middle.
    const value =
      v === null
        ? { x: Math.round(centre - 3), y: valueY + 3, w: 6, h: 2 }
        : { x: Math.round(centre - digitsW(v, vpx) / 2), y: valueY, w: digitsW(v, vpx), h: COUNT_ROWS * vpx };
    const unit = (v === null ? valueY + COUNT_ROWS : value.y + value.h) + UNIT_GAP;
    return { step, mark, place: glyphBox, tier, slot: slotBox, value, vpx, unit };
  };
  return {
    cols,
    rows,
    floor,
    compact: size === 'compact',
    glyph: d.glyph,
    name,
    places: [place(0), place(1), place(2)],
  };
}

// The caption's rows from the name band's top to its block's last line (the DOM's box: what
// dissolves as one).
export const captionRows = (L: PodiumLayout, p: number): number => L.places[p].unit + UNIT_ROWS - L.name;

// A name's RUNS, split at its JOINTS: after an underscore, before a capital that follows a small
// letter, and before digits that follow a letter.
export function runsOf(name: string): string[] {
  const runs: string[] = [];
  let run = '';
  for (let i = 0; i < name.length; i += 1) {
    const prev = name[i - 1] ?? '';
    const ch = name[i];
    const joint =
      prev === '_' || (/[a-z]/.test(prev) && /[A-Z]/.test(ch)) || (/[A-Za-z]/.test(prev) && /[0-9]/.test(ch));
    if (joint && run) {
      runs.push(run);
      run = '';
    }
    run += ch;
  }
  runs.push(run);
  return runs;
}

// How a name SETS in the band's TWO lines, each `roomPx` wide: the face's 12px, or the first size
// a pixel smaller (to 10) at which its runs set in them, none broken — the chrome's mono advances
// a fixed 0.65em a glyph, so a run's width is its length, nothing measured. At 10, a run still
// too long for a line is split in its middle (two even halves rather than a letter left alone);
// and a name whose runs take three lines even so is cut in two at its own middle — a name is at
// most 16 glyphs, 8 a line, which every slot holds at 10. The browser breaks only at the runs'
// joints, so it sets what this says: never a third line.
export const NAME_PX = [12, 11, 10];
export function setName(runs: readonly string[], roomPx: number): { px: number; runs: readonly string[] } {
  const fits = (glyphs: number, px: number) => glyphs * UI_ADVANCE_EM * px <= roomPx;
  const lines = (parts: readonly string[], px: number) => {
    let count = 1;
    let line = 0;
    for (const part of parts) {
      if (!fits(part.length, px)) return Infinity;
      if (fits(line + part.length, px)) line += part.length;
      else {
        count += 1;
        line = part.length;
      }
    }
    return count;
  };
  const px = NAME_PX.find((size) => lines(runs, size) <= 2);
  if (px !== undefined) return { px, runs };
  const least = NAME_PX[NAME_PX.length - 1];
  const halves = (text: string) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
  const halved = runs.flatMap((run) => (fits(run.length, least) ? [run] : halves(run)));
  return { px: least, runs: lines(halved, least) <= 2 ? halved : halves(runs.join('')) };
}

// How a step's face is lit: its light dithers down from the lip over its first SHADE rows,
// and its foot falls off into the ground over its last FOOT — each a share of its height, so
// a short step keeps the flat band its place sits on.
const shadeRows = (h: number) => Math.max(3, Math.round(h * 0.3));
function footRows(h: number): number {
  return Math.max(3, Math.round(h * 0.2));
}

// ── The beats, in ms since the scene began ────────────────────────────────────────────────
// A step rises over RISE_MS, the next one RISE_GAP_MS after (third first, the winner last),
// and its place dissolves in over PLACE_IN_MS once it stands; a player drops once their step
// stands, at least DROP_GAP_MS after the one before, falling DROP_CELLS over DROP_MS and
// shaking on landing; their value's reels start as they land and run the lines' own run —
// first place's FIRST_RUN_MS, the hero's — and a first's cobalt recedes into the foil over
// RECEDE_MS in RECEDE_STEPS once its last shake has played (the result meter's own recede).
// Everything has landed by about two seconds: a board is read at a glance.
export const FRAME_MS = 32;
const RISE_MS = 300;
const RISE_GAP_MS = 60;
const PLACE_IN_MS = 160;
const DROP_AFTER_RISE_MS = 20;
const DROP_GAP_MS = 100;
const DROP_MS = 220;
const DROP_CELLS = 24;
export const SHAKE: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [-1, 0],
  [1, 0],
];
export const SHAKE_FRAME_MS = 40;
const FIRST_RUN_MS = 650;
export const RECEDE_MS = 400;
const RECEDE_STEPS = 8;
// The winner's crown flashes white on the landing's impact, for this long.
const FLASH_MS = 2 * FRAME_MS;
const SURGE_MS = 480;
const SURGE_STEPS = 4;
const HEAT_RISE_MS = 160;
const HEAT_STEPS = 4;
// How many hard steps a place's dissolve takes (the Bayer levels it lights in).
const DISSOLVE_STEPS = 6;
// THE GIVING WAY: a scene replaces the one before cell by cell in the Bayer order over a line's
// own dissolve (`board-dissolve`), in these steps.
const TURN_MS = DISSOLVE_MS;
const TURN_STEPS = 8;
// Long since: what stands from a scene's first frame (a step already up, a player who stays,
// everything on a board already shown) stood this long before it.
const PAST = -10_000;

export interface BeatSpec {
  // A board: its steps stand (not a read still out, a failure or the ghost). A read still out
  // — and, `held`, one asked AGAIN after a failure: its rails stand from the first frame, in the
  // place the failure's line held, rather than waiting the skeleton's wait in again.
  steps: boolean;
  loading: boolean;
  held: boolean;
  // The scene builds (else it is settled from its first frame: a board already shown).
  build: boolean;
  // The steps already stand as it begins (the scene before was a board).
  standing: boolean;
  // Per place: somebody holds it; it is a FIRST place (a tie crowns two); its player held it
  // in the scene before (and stays); its value runs on the reels (a value new on screen).
  present: readonly boolean[];
  firsts: readonly boolean[];
  stood: readonly boolean[];
  reels: readonly boolean[];
  // When the build begins (the screen's arrival leaves the head its beats), and a value's run.
  startMs: number;
  runMs: number;
}

export interface Beats {
  rise: (number | null)[]; // per place: when its step starts rising (null: no steps drawn)
  land: (number | null)[]; // per place: when its player stands (null: nobody there)
  fall: boolean[]; // per place: the player drops onto it (false: stands from the start)
  reel: (number | null)[]; // per place: when its value's reels start (null: it stands)
  run: number[]; // per place: its reels' run
  foil: (number | null)[]; // per first place: when its cobalt recedes into the foil (null: born in it)
  rails: number | null; // a read still out: when its skeleton rails come in (null: none drawn)
  lines: number; // when the lines below start landing
  settled: number; // when nothing but the foil moves any more
}

export function beats(spec: BeatSpec): Beats {
  const rise: (number | null)[] = [null, null, null];
  const land: (number | null)[] = [null, null, null];
  const fall = [false, false, false];
  const reel: (number | null)[] = [null, null, null];
  const run = [spec.runMs, spec.runMs, spec.runMs];
  const foil: (number | null)[] = [null, null, null];
  const ends = [TURN_MS];
  if (!spec.steps) {
    const rails = spec.loading ? (spec.held ? PAST : SKELETON_WAIT_MS) : null;
    const settled = rails !== null && rails > 0 ? rails + DISSOLVE_MS : TURN_MS;
    return { rise, land, fall, reel, run, foil, rails, lines: 0, settled };
  }
  const start = spec.startMs;
  let lastDrop = -Infinity;
  [2, 1, 0].forEach((p, k) => {
    const up = spec.build && !spec.standing ? start + k * RISE_GAP_MS : PAST;
    rise[p] = up;
    ends.push(up + RISE_MS + PLACE_IN_MS);
    if (!spec.present[p]) return;
    if (!spec.build || (spec.standing && spec.stood[p])) {
      land[p] = PAST;
    } else {
      fall[p] = true;
      // Onto steps already standing, the first drops once the one leaving is half gone.
      const drop = Math.max(up + RISE_MS + DROP_AFTER_RISE_MS, lastDrop + DROP_GAP_MS, start + (spec.standing ? TURN_MS / 2 : 0));
      lastDrop = drop;
      land[p] = drop + DROP_MS;
      ends.push(land[p]! + SHAKE.length * SHAKE_FRAME_MS + SURGE_MS);
    }
    if (spec.firsts[p]) run[p] = FIRST_RUN_MS;
    if (spec.build && spec.reels[p]) {
      reel[p] = Math.max(land[p]!, start);
      ends.push(reel[p]! + runEnd(run[p]));
      // A first's foil comes as its reels have played out (one standing is born in it).
      if (spec.firsts[p]) {
        foil[p] = reel[p]! + runEnd(run[p]);
        ends.push(foil[p]! + RECEDE_MS);
      }
    }
  });
  // The lines: on a TURN (the steps already standing) they give way with the podium, from its
  // first frame — the board before keeps every slot until its line is taken; on an ARRIVAL
  // they follow the podium in, once the last landing's shake has played (the winner's impact
  // owns its beat) — or, nobody dropping, as the last step stands.
  const lines =
    !spec.build || spec.standing
      ? start
      : Number.isFinite(lastDrop)
        ? lastDrop + DROP_MS + SHAKE.length * SHAKE_FRAME_MS
        : start + 2 * RISE_GAP_MS + RISE_MS / 2;
  return { rise, land, fall, reel, run, foil, rails: null, lines, settled: Math.max(...ends) };
}

// A whole-cell ease: the share of a travel `k` (0–1) that has been made, eased out.
const easeOut = (k: number) => 1 - (1 - k) ** 3;
const clamp01 = (k: number) => Math.max(0, Math.min(1, k));
// The frame a time falls in: the raster steps at FRAME_MS, so a beat lands on a frame.
export const framed = (t: number) => Math.floor(t / FRAME_MS) * FRAME_MS;
// How much of a cobalt receding into the foil from `from` still stands at the frame `t`: 1
// whole, 0 gone, in RECEDE_STEPS hard steps over RECEDE_MS.
export const recedeLevel = (t: number, from: number) =>
  Math.ceil((1 - clamp01((t - from) / RECEDE_MS)) * RECEDE_STEPS) / RECEDE_STEPS;

// How many of its `h` rows a step rising from `at` stands at `t`: whole rows, eased out.
function risenRows(at: number | null, h: number, t: number): number {
  if (at === null) return 0;
  return Math.round(h * easeOut(clamp01((framed(t) - at) / RISE_MS)));
}

// Where a player's mark stands at `t`, as a whole-cell offset from its rest, and whether it is
// on screen yet: falling under gravity, then the landing's shake — or standing from the start.
export function markAt(beat: { land: number | null; fall: boolean }, t: number): { shown: boolean; dx: number; dy: number } {
  const { land, fall } = beat;
  if (land === null) return { shown: false, dx: 0, dy: 0 };
  if (!fall) return { shown: true, dx: 0, dy: 0 };
  const at = framed(t);
  const drop = land - DROP_MS;
  if (at < drop) return { shown: false, dx: 0, dy: 0 };
  if (at < land) {
    const k = (at - drop) / DROP_MS;
    return { shown: true, dx: 0, dy: -Math.round(DROP_CELLS * (1 - k * k)) };
  }
  const frame = Math.floor((at - land) / SHAKE_FRAME_MS);
  const [dx, dy] = SHAKE[frame] ?? [0, 0];
  return { shown: true, dx, dy };
}

// The scene's giving way at `t`: the share of its cells already its own (the rest still the
// scene before's), in TURN_STEPS hard steps.
export const turnLevel = (t: number): number => Math.floor(clamp01(t / TURN_MS) * TURN_STEPS) / TURN_STEPS;

// ── The raster ────────────────────────────────────────────────────────────────────────────
// What the box shows (see FOUR PICTURES above).
export type PodiumMode = 'loading' | 'failed' | 'ghost' | 'board';

interface PodiumData {
  mode: PodiumMode;
  // Per place, or null for a place nobody holds. `me`: the reader's own place.
  places: readonly ({ rank: number; value: number; near: number; me: boolean } | null)[];
}

interface PodiumScene {
  // Paint the whole frame at `t` into `px` (cols × rows, ABGR) — first place's foil with it,
  // or not (the resting frame the foil is repainted over).
  draw: (px: Uint32Array, t: number, withFoil: boolean) => void;
  // Repaint only the FOIL at `t` over a frame drawn at rest: the box it touches (its field),
  // so the resting clock repaints a few hundred cells.
  foil: (px: Uint32Array, rest: Uint32Array, t: number) => void;
  // The foil's boxes, to upload: what `foil` may have touched.
  foilBoxes: readonly Box[];
}

export function podiumScene(L: PodiumLayout, data: PodiumData, tl: Beats, seed: number): PodiumScene {
  const { cols, rows } = L;
  const put = (px: Uint32Array, x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    px[y * cols + x] = v;
  };
  const board = data.mode === 'board';
  const places = L.places.map((place, p) => {
    const held = board ? (data.places[p] ?? null) : null;
    const text = held ? String(held.value) : '';
    return { place, held, text, digits: Array.from(text, Number), ink: held ? countInk(DIGIT_MASKS, text) : null };
  });
  // The first places (a tie crowns every one): each with its value's box, its resting ink as
  // cells of that box, and when its foil comes — and THE FOIL'S FIELD, the box over them all:
  // one material, so tied firsts wear one sheen crossing both, not two shiny things.
  const firsts = places.flatMap(({ place, held, ink }, p) => {
    if (!held || !ink || place.tier !== 0) return [];
    const fpx = place.vpx;
    const cells = (x: number, y: number) => ink(Math.floor(x / fpx), Math.floor(y / fpx));
    return [{ value: place.value, cells, from: tl.foil[p] }];
  });
  const field: Box | null =
    firsts.length === 0
      ? null
      : (() => {
          const x = Math.min(...firsts.map((f) => f.value.x));
          const y = Math.min(...firsts.map((f) => f.value.y));
          return {
            x,
            y,
            w: Math.max(...firsts.map((f) => f.value.x + f.value.w)) - x,
            h: Math.max(...firsts.map((f) => f.value.y + f.value.h)) - y,
          };
        })();
  const foilBoxes: Box[] = field ? [field] : [];

  // THE CLEARING: bare round each mark at rest, the heat returning over a ramp.
  const keeps: HeatKeep[] = places.flatMap(({ place, held }) => (held ? [{ ...place.mark, clear: 1, ramp: 4 }] : []));

  // A dissolve's level at `t` from `from`, in DISSOLVE_STEPS hard steps.
  const level = (from: number | null, ms: number, t: number) =>
    from === null ? 0 : Math.ceil(clamp01((framed(t) - from) / ms) * DISSOLVE_STEPS) / DISSOLVE_STEPS;

  // THE GHOST of a step: its silhouette in the floor's own stipple — a dot every third cell
  // along its lip and down its face, on the floor's lattice — drawn as lightly as the rows a
  // board leaves out; never an outline.
  const ghostStep = (px: Uint32Array, s: Box) => {
    for (let y = s.y; y < L.floor; y += 1) {
      if (y !== s.y && (L.floor - y) % 3 !== 0) continue;
      for (let x = s.x; x < s.x + s.w; x += 1) if ((x - 4) % 3 === 0) put(px, x, y, RAIL);
    }
  };

  // A step standing `h` rows tall off the floor, LIT FROM ABOVE the pixel art's way: the lip
  // (its top corners cut), then the face — the iron's light dithered down into its dusk
  // through the Bayer order — and its foot falling off into the ground. A drawn object, never
  // a panel.
  const step = (px: Uint32Array, s: Box, h: number) => {
    const top = s.y + s.h - h;
    const shade = shadeRows(s.h);
    const foot = footRows(s.h);
    for (let y = top; y < s.y + s.h; y += 1) {
      const row = y - top;
      const fromFoot = s.y + s.h - 1 - y;
      for (let x = s.x; x < s.x + s.w; x += 1) {
        if (row === 0 && (x === s.x || x === s.x + s.w - 1)) continue;
        if (row < LIP) {
          put(px, x, y, RAIL);
          continue;
        }
        const th = bayerThreshold(x, y);
        if (fromFoot < foot && th > 0.35 + (0.65 * fromFoot) / foot) continue;
        const lit = 1 - (row - LIP) / shade;
        put(px, x, y, lit > 0 && th < lit * 0.75 ? RAIL : DUSK);
      }
    }
  };

  // A step's PLACE, cut into its face: a cell of dusk round the glyph's ink (the outline that
  // lifts it off the dither), then the ink, dissolving in through the Bayer order at `lv`.
  const placeGlyph = (px: Uint32Array, box: Box, tier: number, fpx: number, ink: number, lv: number) => {
    const digit = countInk(DIGIT_MASKS, String(tier + 1));
    const at =
      tier === 0
        ? (x: number, y: number) => crownInk(Math.floor(x / fpx), Math.floor(y / fpx))
        : (x: number, y: number) => digit(Math.floor(x / fpx), Math.floor(y / fpx));
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < box.w && y < box.h && at(x, y);
    for (let y = -1; y <= box.h; y += 1) {
      for (let x = -1; x <= box.w; x += 1) {
        const cy = box.y + y;
        if (bayerThreshold(box.x + x, cy) >= lv) continue;
        if (inside(x, y)) {
          put(px, box.x + x, cy, ink);
        } else if (inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1)) {
          put(px, box.x + x, cy, DUSK);
        }
      }
    }
  };

  // A VALUE at `t`, in `inkOf`'s ink a cell: on its reels while they run (each reel's strip at
  // a whole font pixel, shaken by whole font pixels on its stop), its digits at rest after.
  const value = (px: Uint32Array, p: number, t: number, inkOf: (x: number, y: number) => number) => {
    const { place, digits } = places[p];
    const from = tl.reel[p];
    const n = digits.length;
    const fpx = place.vpx;
    const ms = from === null ? Infinity : framed(t) - from;
    const running = ms < runEnd(tl.run[p]);
    for (let i = 0; i < n; i += 1) {
      const r = running ? runReel(digits[i], i, n, ms, tl.run[p]) : { travelled: digits[i], dx: 0, dy: 0 };
      const ink = reelInk(DIGIT_MASKS, [reelRow(r.travelled % 10)]);
      for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
        for (let gx = 0; gx < COUNT_EM; gx += 1) {
          if (!ink(gx, gy)) continue;
          const x0 = place.value.x + (i * COUNT_EM + gx + r.dx) * fpx;
          const y0 = place.value.y + (gy + r.dy) * fpx;
          for (let cy = 0; cy < fpx; cy += 1) {
            for (let cx = 0; cx < fpx; cx += 1) put(px, x0 + cx, y0 + cy, inkOf(x0 + cx, y0 + cy));
          }
        }
      }
    }
  };

  // FIRST PLACE'S FOIL: the shared material over the values' cells — those whose foil has
  // come — its sheen timed off the moment the first came; while one comes, its cobalt still
  // standing on the cells the Bayer order has not reached; the glitter, kept to the ink, once
  // they are whole.
  const paintFoil = (px: Uint32Array, t: number) => {
    if (!field) return;
    const at = framed(t);
    const come = firsts.filter(({ from }) => from === null || at >= from);
    if (come.length === 0) return;
    const ink = (x: number, y: number) =>
      come.some(({ value, cells }) => {
        const cx = field.x + x - value.x;
        const cy = field.y + y - value.y;
        return cx >= 0 && cy >= 0 && cx < value.w && cy < value.h && cells(cx, cy);
      });
    const seconds = t / 1000;
    const froms = come.map(({ from }) => from);
    const since = froms.includes(null) ? null : Math.min(...(froms as number[])) / 1000;
    foilCells(field.w, field.h, seconds, seed, since, ink, 1, (v, x, y) => {
      const [r, g, b] = v === FOIL_WHITE ? [255, 255, 255] : foilInkRgb(v);
      put(px, field.x + x, field.y + y, abgr(r, g, b));
    });
    let receding = false;
    for (const { value: box, cells, from } of come) {
      const solid = from === null ? 0 : recedeLevel(at, from);
      if (solid <= 0) continue;
      receding = true;
      for (let y = 0; y < box.h; y += 1) {
        for (let x = 0; x < box.w; x += 1) {
          if (cells(x, y) && bayerThreshold(box.x + x, box.y + y) < solid) put(px, box.x + x, box.y + y, COBALT);
        }
      }
    }
    if (receding) return;
    foilGlitter(field.w, field.h, seconds, seed, ink, SPARKLE_SHARE, 1, (x, y, w, h) => {
      for (let yy = 0; yy < h; yy += 1) {
        for (let xx = 0; xx < w; xx += 1) if (ink(x + xx, y + yy)) put(px, field.x + x + xx, field.y + y + yy, WHITE);
      }
    });
  };

  // A place's heat at `t`: how far it has risen off its step (0 until its player lands, then
  // whole in HEAT_STEPS hard steps — the landing ignites it) and its surge (1 on the landing,
  // falling to 0 in SURGE_STEPS; the winner's landing surges every place's).
  const heatAt = (p: number, t: number) => {
    const land = tl.land[p];
    const at = framed(t);
    if (land === null || at < land) return { up: 0, lift: 0 };
    const up = Math.min(HEAT_STEPS, Math.floor(((at - land) / HEAT_RISE_MS) * HEAT_STEPS) + 1) / HEAT_STEPS;
    const surge = (from: number | null, falls: boolean) =>
      from === null || !falls || at < from || at >= from + SURGE_MS
        ? 0
        : 1 - Math.floor(((at - from) / SURGE_MS) * SURGE_STEPS) / SURGE_STEPS;
    return { up, lift: Math.max(surge(land, tl.fall[p]), surge(tl.land[0], tl.fall[0])) };
  };

  const draw = (px: Uint32Array, t: number, withFoil: boolean) => {
    px.fill(0);
    // THE FLOOR: the result's stippled rail, across the column.
    for (let x = 4; x < cols - 4; x += 3) put(px, x, L.floor, RAIL);
    // A failed read: the floor alone, still — the box's caption says what failed where the
    // rails stood.
    if (data.mode === 'failed') return;
    if (data.mode === 'loading') {
      // A slow read: the skeleton's rails where each name will stand, on the floor's lattice —
      // after the lines' skeleton's own wait (a quick read never flashes them), through a
      // line's dissolve; a read asked again after a failure, at once (`tl.rails`).
      const lv = level(tl.rails, DISSOLVE_MS, t);
      if (lv <= 0) return;
      const y = L.name + NAME_ROWS - 5;
      for (const { slot } of L.places) {
        const reach = Math.floor(slot.w * 0.3);
        const centre = slot.x + Math.floor(slot.w / 2);
        for (let x = centre - reach; x <= centre + reach; x += 1) {
          if ((x - 4) % 3 === 0 && bayerThreshold(x, y) < lv) put(px, x, y, RAIL);
        }
      }
      return;
    }
    if (data.mode === 'ghost') {
      L.places.forEach((place) => ghostStep(px, place.step));
      return;
    }

    places.forEach(({ place, held }, p) => {
      if (!held) return;
      const { up, lift } = heatAt(p, t);
      if (up <= 0) return;
      // THE HEAT off the step's top to the box's, behind its player: one column a cell, in this
      // place's nearness ink, spilling SPILL cells past the step's sides.
      const s = place.step;
      const color = rgbToAbgr(progressHeatColor(held.near));
      const x0 = s.x - SPILL;
      const w = s.w + 2 * SPILL;
      heatCells(
        {
          cols: w,
          rows: s.y,
          width: w,
          cell: 1,
          trajectory: [held.near],
          shown: 1,
          rise: () => up,
          lift,
          clear: (cx, cy) => heatKeepOut(keeps, x0 + cx + 0.5, s.y - cy - 0.5),
        },
        (_, cx, cy) => put(px, x0 + cx, s.y - 1 - cy, color),
      );
    });

    places.forEach(({ place, held }, p) => {
      const h = risenRows(tl.rise[p], place.step.h, t);
      if (h <= 0) return;
      step(px, place.step, h);
      // The place dissolves onto the face once the step stands; the winner's crown flashes
      // white on the landing's impact; the reader's own place is in the accent.
      const lv = level(tl.rise[p]! + RISE_MS, PLACE_IN_MS, t);
      if (lv > 0) {
        const land = tl.land[p];
        const flash = place.tier === 0 && tl.fall[p] && land !== null && framed(t) >= land && framed(t) < land + FLASH_MS;
        const inkOf = flash ? WHITE : place.tier === 0 || held?.me ? COBALT : MUTED;
        placeGlyph(px, place.place, place.tier, L.glyph, inkOf, lv);
      }
      // A place nobody holds: its dash, quiet, in the value's row — the caption is waiting.
      if (!held) {
        if (lv <= 0) return;
        const d = place.value;
        for (let y = d.y; y < d.y + d.h; y += 1) {
          for (let x = d.x; x < d.x + d.w; x += 1) if (bayerThreshold(x, y) < lv) put(px, x, y, RAIL);
        }
        return;
      }
      // The value comes as its player lands — on its reels, or standing. A first's is cobalt
      // until its foil comes (the foil paints it from then on).
      const land = tl.land[p];
      if (land === null || framed(t) < land) return;
      if (place.tier !== 0) {
        value(px, p, t, () => WHITE);
        return;
      }
      const from = tl.foil[p];
      if (from === null || framed(t) >= from) return;
      value(px, p, t, () => COBALT);
    });

    if (withFoil) paintFoil(px, t);
  };

  const foil = (px: Uint32Array, rest: Uint32Array, t: number) => {
    for (const b of foilBoxes) {
      for (let y = b.y; y < b.y + b.h && y < rows; y += 1) {
        const from = y * cols + b.x;
        px.set(rest.subarray(from, from + Math.min(b.w, cols - b.x)), from);
      }
    }
    paintFoil(px, t);
  };

  return { draw, foil, foilBoxes };
}
