import { COUNT_EM, COUNT_ROWS, DIGIT_MASKS, bayerThreshold as th, hash3, reelInk, reelRow, sparkleAt } from '@whippin/shared';
import { runEnd, runReel } from '../countRun';
import { CROWN_MS, timeline, type Timeline } from '../streak/beats';
import {
  COBALT,
  DEEP,
  DUSK,
  FOIL,
  FOIL_DEEP,
  LINK_H,
  LINK_PITCH,
  LINK_W,
  MUTED,
  RAIL,
  WHITE,
  flame,
  linkCellsAt,
  shade,
  star,
  type Crown,
  type LinkPlace,
  type Put,
} from '../streak/sprites';

// THE ACCOUNT'S RECORD — the account screen's subject, in the streak celebration's own
// language (`StreakDialog`, `streak/`): ONE raster of whole cells on the bare ground, in the
// celebration's inks and sprites and nothing else, deterministic in `t` — the time since the
// screen began — so a frame is the same on every device and reduced motion is one `t` held.
//
//   THE FLAME over the number: the celebration's crown (`flame`), lit when the account has a
//     live streak — and on a streak of nothing, its PILOT: the spark that breathes at the foot
//     of an unlit flame, waiting to catch. Never a broken picture: a zero is a fire not lit.
//   THE COUNT: the streak in the pixel face's own digits, a glyph pixel a square of `K` cells,
//     LANDING ON THE COUNT'S REELS (`countRun.ts`, the board's compressed run: every reel
//     spinning from almost the same instant, stopping left to right with a whole-pixel shake).
//     White-hot when it burns; a zero lands in IRON (the unlit link's own ink). As the last
//     reel stops the count throws its LIGHT (the celebration's halo: a DEEP dither round its
//     strokes, cooling away) and the flame catches.
//   THE WEEK under it as the celebration's CHAIN, Monday first: a played day's link solid
//     cobalt, an edge-on link threaded through two played neighbours; a day to come the
//     link's empty ghost; a day missed an iron link left open; TODAY, solved, the holographic
//     FOIL — the screen's one shiny thing — and today still open, its ghost BREATHING, the
//     one link asking for something. After the landing the light runs along the chain,
//     Monday first, each played link flashing white as it is reached; today's is struck white
//     and cools into its foil cell by cell, throwing a burst of the glitter's stars.
//
// The DOM words (the unit, the initials) stand where `recordLayout` says.

// The house's streak cell (the celebration's phone cell), in CSS px.
export const RECORD_CELL_PX = 3;
// Cells a glyph pixel of the count: 15px — the celebration's own face on a phone — where the
// column holds it, else 12px.
const K_ROOMY = 5;
const K_TIGHT = 4;
// Between the flame's foot and the count's top; the count to the chain (the unit's line); the
// chain's foot to the raster's.
const CROWN_GAP = 6;
const UNIT_ROWS = 11;
const FOOT_ROWS = 3;

export interface RecordLayout {
  k: number; // cells a glyph pixel of the count
  cols: number;
  rows: number;
  cx: number;
  crown: Crown;
  count: { x: number; y: number; w: number; h: number };
  links: LinkPlace[];
  // DOM placements, CSS px: the unit's centre line, each initial's centre.
  unitY: number;
  labels: { x: number; y: number }[];
}

// The count's INK width in font pixels, at rest: every glyph's advance but the last, and the
// last glyph's own ink (a `1` is narrower than its advance) — so the number centres on what it
// prints.
const inkPx = (value: number) => {
  const text = String(Math.max(0, Math.floor(value)));
  return (text.length - 1) * COUNT_EM + DIGIT_MASKS[Number(text[text.length - 1])].w;
};

export function recordLayout(widthPx: number, value: number, compact = false): RecordLayout {
  const cols = Math.max(1, Math.floor(widthPx / RECORD_CELL_PX));
  const cx = Math.round(cols / 2);
  // The face as large as the column holds the count at — sized for two digits at least, so
  // 9 → 10 never shrinks it (a hundredth day may: a milestone, not every week) — with a few
  // cells of ground either side.
  const k = !compact && Math.max(inkPx(10), inkPx(value)) * K_ROOMY + 8 <= cols ? K_ROOMY : K_TIGHT;
  // The flame in proportion to the face: its height, its half-width, and the room over its
  // foot that its tip, its flare and its embers take.
  const flameH = Math.round(k * 4.2);
  const flameRoom = Math.round(flameH * 1.55) + 3;
  const crownFoot = flameRoom;
  const countTop = crownFoot + CROWN_GAP;
  const w = inkPx(value) * k;
  const h = COUNT_ROWS * k;
  const countBottom = countTop + h;
  // The links' centre on a cell's edge, so each sprite lands on whole cells.
  const linkY = countBottom + UNIT_ROWS + LINK_H / 2;
  const links = Array.from({ length: 7 }, (_, i): LinkPlace => ({ x: cx + (i - 3) * LINK_PITCH + 0.5, y: linkY }));
  const rows = linkY + LINK_H / 2 + FOOT_ROWS;
  const labelY = (linkY + LINK_H / 2) * RECORD_CELL_PX + 8 + 9;
  return {
    k,
    cols,
    rows,
    cx,
    crown: { x: cx, y: crownFoot, h: flameH, w: k + 1 },
    count: { x: Math.round(cx - w / 2), y: countTop, w, h },
    links,
    unitY: (countBottom + UNIT_ROWS / 2) * RECORD_CELL_PX,
    labels: links.map((link) => ({ x: link.x * RECORD_CELL_PX, y: labelY })),
  };
}

// ── While the numbers are out ─────────────────────────────────────────────────────────────
// The week's seven links as their empty, dashed GHOSTS — the chain's place held in iron, so
// nothing moves when the collections land and the chain dithers in over it. Raster indices.
export function ghostChainCells(L: RecordLayout): number[] {
  const out: number[] = [];
  for (const link of L.links) {
    for (const c of linkCellsAt(link)) {
      if (c.ghost && c.x >= 0 && c.y >= 0 && c.x < L.cols && c.y < L.rows) out.push(c.y * L.cols + c.x);
    }
  }
  return out;
}

// ── The week, as the record reads it ──────────────────────────────────────────────────────
export interface RecordDay {
  solved: boolean;
  today: boolean;
  future: boolean;
}

// ── The beats, in ms since the screen began ───────────────────────────────────────────────
// The chain dithers in over LINKS_IN_MS, Monday first; the count's reels start at REEL_AT and
// run RUN_MS (the board's compressed run); as the last one stops the count throws its light
// (HALO_MS) and the flame catches (the celebration's CROWN_MS), flaring; RUN_AFTER_MS later the
// light runs along the chain, RUN_STEP_MS a link — each played link white for one step, today's
// struck white for STRIKE_MS and cooling into the foil over COOL_MS.
const LINKS_IN_MS = 300;
const REEL_AT = 80;
export const RECORD_RUN_MS = 900;
const HALO_MS = 620;
const RUN_AFTER_MS = 120;
const RUN_STEP_MS = 60;
const STRIKE_MS = 100;
const COOL_MS = 380;
const BURST_MS = 420;
// Long since: what stands from the first frame on a screen already shown.
const PAST = -10_000;

export interface RecordBeats {
  linksIn: number;
  reel: number;
  impact: number;
  run: number;
  settled: number;
}

export function recordBeats(build: boolean): RecordBeats {
  if (!build) return { linksIn: PAST, reel: PAST, impact: PAST + RECORD_RUN_MS, run: PAST, settled: 0 };
  const reel = REEL_AT;
  const impact = reel + RECORD_RUN_MS;
  const run = impact + RUN_AFTER_MS;
  const settled = Math.max(reel + runEnd(RECORD_RUN_MS), impact + HALO_MS, run + 7 * RUN_STEP_MS + STRIKE_MS + COOL_MS + BURST_MS);
  return { linksIn: 0, reel, impact, run, settled };
}
// THE TWO OTHER NUMBERS spin up with the count and land FIRST, left to right — so the big
// one, landing last, is the beat the flame catches on. When each starts, and its run.
export const SIDE_RUN_MS = 560;
export const sideReelsAt = (b: RecordBeats, i: number) => Math.max(0, b.reel + 60 + i * 90);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
// THE ZERO'S BREATH: the unlit flame's ghost and today's open link breathe on ONE clock, in
// hard steps — fuller, then back.
const BREATH_S = 2.4;

// The flame's timeline: the celebration's own, its beats moved onto the record's — the orbit
// long met at the top, the crown catching on the impact (never, on a streak of nothing: the
// pilot breathes on), the flare as the light comes back up.
function flameTimeline(b: RecordBeats, lit: boolean): Timeline {
  const base = timeline(false, false, 0);
  return {
    ...base,
    orbitIn: PAST * 2,
    crown: lit ? b.impact : Infinity,
    flare: lit ? b.impact + CROWN_MS * 0.6 : Infinity,
  };
}

export interface RecordFoil {
  u: Float32Array;
  phase: Float32Array;
}

export interface RecordScene {
  // Paint the frame at `t` as INK INDICES (the celebration's `INKS`, 0 the ground); FOIL cells
  // carry their place on their link's diagonal in `foil`.
  draw(ink: Uint8Array, t: number, foil: RecordFoil): void;
  // Whether anything still moves at rest (a lit flame, a pilot, a foil, a breathing link).
  alive: boolean;
}

export function recordScene(L: RecordLayout, streak: number, days: readonly RecordDay[], b: RecordBeats): RecordScene {
  const { cols, rows, k: K } = L;
  const lit = streak > 0;
  const tl = flameTimeline(b, lit);
  const digits = Array.from(String(Math.max(0, Math.floor(streak))), Number);
  const n = digits.length;
  const linkCells = L.links.map((link) => linkCellsAt(link));
  const todayIndex = days.findIndex((d) => d.today);
  const played = (i: number) => days[i]?.solved ?? false;
  const missed = (i: number) => !days[i].solved && !days[i].today && !days[i].future;
  // When the light reaches link i on its run, Monday first.
  const reach = (i: number) => b.run + i * RUN_STEP_MS;

  // THE HALO's field: each cell's distance to the count's nearest inked block, measured once
  // over the count's box grown by the halo's reach (the celebration's `countLayer`).
  const haloR = 9;
  const restInk = reelInk(DIGIT_MASKS, digits.map((d) => reelRow(d)));
  const hx0 = L.count.x - haloR;
  const hy0 = L.count.y - haloR;
  const hw = L.count.w + 2 * haloR;
  const hh = L.count.h + 2 * haloR;
  const halo = new Float32Array(hw * hh).fill(99);
  for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
    for (let gx = 0; gx < n * COUNT_EM; gx += 1) {
      if (!restInk(gx, gy)) continue;
      const bx = gx * K + haloR;
      const by = gy * K + haloR;
      for (let y = Math.max(0, by - haloR); y < Math.min(hh, by + K + haloR); y += 1) {
        for (let x = Math.max(0, bx - haloR); x < Math.min(hw, bx + K + haloR); x += 1) {
          const ox = Math.max(bx - (x + 0.5), 0, x + 0.5 - (bx + K));
          const oy = Math.max(by - (y + 0.5), 0, y + 0.5 - (by + K));
          const d = Math.hypot(ox, oy);
          const j = y * hw + x;
          if (d < halo[j]) halo[j] = d;
        }
      }
    }
  }

  const todayFoil = todayIndex >= 0 && days[todayIndex].solved;

  // The unlit flame's silhouette: the flame at rest, drawn once into a mask.
  const ghostFlame = new Uint8Array(lit ? 0 : cols * rows);
  if (!lit) {
    const rest = { ...tl, crown: PAST, flare: Infinity };
    flame(
      (x, y, v) => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        // The flame's body only — not its light's dither.
        if (v !== DEEP && xi >= 0 && yi >= 0 && xi < cols && yi < rows && yi < L.crown.y - 1) ghostFlame[yi * cols + xi] = 1;
      },
      L.crown,
      0,
      rest,
      0.4,
      false,
    );
  }

  // …its outline, dashed: every cell of the silhouette with ground beside it, but one in three
  // along the diagonal left out — the ghost links' own broken stroke.
  const ghostEdge: number[] = [];
  if (!lit) {
    const inMask = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && ghostFlame[y * cols + x] === 1;
    for (let i = 0; i < ghostFlame.length; i += 1) {
      if (!ghostFlame[i]) continue;
      const x = i % cols;
      const y = (i - x) / cols;
      const around = +inMask(x - 1, y) + +inMask(x + 1, y) + +inMask(x, y - 1) + +inMask(x, y + 1);
      // (A lone cell is an ember the frozen flame threw: no part of its outline.)
      if (around > 0 && around < 4 && (x + y) % 3 !== 2) ghostEdge.push(i);
    }
  }

  return {
    alive: true,
    draw(ink, t, foil) {
      ink.fill(0);
      const seconds = t / 1000;
      const put: Put = (x, y, v) => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) return;
        ink[yi * cols + xi] = v;
      };

      // ── 1. THE LIGHT the landing throws: a DEEP dither round the count's strokes, cooling.
      if (lit) {
        const glow = clamp01((t - b.impact) / HALO_MS);
        if (t >= b.impact && glow < 1) {
          const peak = 0.62 * (1 - glow) ** 1.5;
          for (let y = 0; y < hh; y += 1) {
            for (let x = 0; x < hw; x += 1) {
              const d = halo[y * hw + x];
              if (d <= 0 || d >= haloR) continue;
              if (th(hx0 + x, hy0 + y) < peak * (1 - d / haloR) ** 1.3) put(hx0 + x, hy0 + y, DEEP);
            }
          }
        }
      }

      // ── 2. THE FLAME — or, unlit, its GHOST: the flame's own outline, EMPTY and DASHED in
      // iron, the chain's grammar for a thing still to come (a day to come is its link's
      // dashed ghost; a fire to come is its flame's), lifting from iron to the muted ink on
      // the beat today's open link breathes on — and the pilot waiting at its foot.
      if (!lit) {
        const beat = Math.floor(((seconds / BREATH_S) % 1) * 8);
        const v = beat === 3 || beat === 4 ? MUTED : RAIL;
        for (const at of ghostEdge) put(at % cols, Math.floor(at / cols), v);
      }
      flame(put, L.crown, Math.max(0, t), tl, seconds, false);
      // The pilot, held a touch larger than the celebration's spark: on a zero it is the one
      // live thing over the number, and it has to read at a glance.
      if (!lit) {
        const s = Math.floor(seconds / 0.09);
        const flick = hash3(s, 5, 61) > 0.5;
        const bx = L.crown.x - 1;
        const by = L.crown.y;
        put(bx - 1, by, COBALT);
        put(bx + 1, by, COBALT);
        put(bx, by, WHITE);
        put(bx, by - 1, flick ? WHITE : COBALT);
        put(bx - 1, by - 1, DEEP);
        put(bx + 1, by - 1, COBALT);
        put(bx, by - 2, COBALT);
        put(flick ? bx + 1 : bx, by - 3, flick ? DEEP : COBALT);
      }

      // ── 3. THE COUNT on its reels: white-hot when it burns, iron when it does not.
      if (t >= b.reel) {
        const ms = t - b.reel;
        const running = ms < runEnd(RECORD_RUN_MS);
        const v = lit ? WHITE : running ? MUTED : RAIL;
        // A count of nothing is IRON, the unlit link's metal, cut the iron keys' way: lit from
        // above — the top row of every stroke catching the light, the body falling off into
        // its dusk through the Bayer order toward the foot.
        const iron = !lit && !running;
        for (let i = 0; i < n; i += 1) {
          const r = running ? runReel(digits[i], i, n, ms, RECORD_RUN_MS) : { travelled: digits[i], dx: 0, dy: 0 };
          const glyph = reelInk(DIGIT_MASKS, [reelRow(r.travelled % 10)]);
          for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
            for (let gx = 0; gx < COUNT_EM; gx += 1) {
              if (!glyph(gx, gy)) continue;
              const x0 = L.count.x + (i * COUNT_EM + gx + r.dx) * K;
              const y0 = L.count.y + (gy + r.dy) * K;
              if (!iron) {
                for (let cy = 0; cy < K; cy += 1) for (let cx = 0; cx < K; cx += 1) put(x0 + cx, y0 + cy, v);
                continue;
              }
              const lip = gy === 0 || !glyph(gx, gy - 1);
              for (let cy = 0; cy < K; cy += 1) {
                for (let cx = 0; cx < K; cx += 1) {
                  const X = x0 + cx;
                  const Y = y0 + cy;
                  const fall = (gy * K + cy) / (COUNT_ROWS * K);
                  const dusk = fall > 0.5 && th(X, Y) < ((fall - 0.5) / 0.5) * 0.8;
                  put(X, Y, lip && cy === 0 ? MUTED : dusk ? DUSK : RAIL);
                }
              }
            }
          }
        }
      }

      // ── 4. THE CHAIN. Each link dithers in as the sweep reaches it, Monday first.
      const sweep = clamp01((t - b.linksIn) / LINKS_IN_MS);
      const appear = (i: number) => clamp01(sweep * 1.6 - i * 0.1);
      // A played day's link as the light finds it: iron until the run reaches it, white for a
      // step, then cobalt.
      const playedInk = (i: number) => (t < reach(i) ? RAIL : t < reach(i) + RUN_STEP_MS ? WHITE : COBALT);
      // The edge-on links between two played neighbours: a flat bar from hole to hole, behind
      // the face-on links, lit as the light passes.
      for (let i = 0; i < 6; i += 1) {
        if (!(played(i) && played(i + 1))) continue;
        if (appear(i + 1) < 1) continue;
        const a = L.links[i];
        const c = L.links[i + 1];
        const y = Math.round(a.y) - 1;
        const x0 = Math.round(a.x - LINK_W / 2) + 7;
        const x1 = Math.round(c.x - LINK_W / 2) + 3;
        const v = t < reach(i + 1) ? RAIL : COBALT;
        for (let x = x0; x <= x1; x += 1) {
          put(x, y, v);
          put(x, y + 1, shade(v));
        }
      }
      for (let i = 0; i < 7; i += 1) {
        const day = days[i];
        const shown = appear(i);
        if (shown <= 0) continue;
        const phase = (i - todayIndex) * 0.17;
        for (const c of linkCells[i]) {
          if (c.part === 'hole') continue;
          if (shown < 1 && th(c.x, c.y) >= shown) continue;
          let v = 0;
          if (day.today && day.solved) {
            // STRUCK as the light reaches it, then cooled into the foil in the dither's order.
            const since = t - reach(i);
            if (since < 0) v = RAIL;
            else if (since < STRIKE_MS) v = WHITE;
            else v = (since - STRIKE_MS) / COOL_MS <= th(c.x, c.y) ? WHITE : FOIL;
          } else if (day.solved) {
            v = playedInk(i);
          } else if (day.today) {
            // TODAY, still open: the one link asking for something — its ghost in the muted
            // ink, BREATHING to white and back in hard steps every couple of seconds.
            if (!c.ghost) continue;
            const breath = Math.floor(((seconds / BREATH_S) % 1) * 8);
            v = breath === 3 || breath === 4 ? WHITE : MUTED;
          } else if (day.future) {
            v = c.ghost ? RAIL : 0;
          } else if (missed(i)) {
            v = c.cut ? 0 : RAIL;
          }
          if (v === 0) continue;
          const at = c.y * cols + c.x;
          if (c.x < 0 || c.y < 0 || c.x >= cols || c.y >= rows) continue;
          const shaded = c.part === 'deep' ? shade(v) : v;
          ink[at] = shaded;
          if (shaded === FOIL || shaded === FOIL_DEEP) {
            foil.u[at] = (c.lx + c.ly) / (LINK_W + LINK_H - 2);
            foil.phase[at] = phase;
          }
        }
      }

      // ── 5. TODAY'S FOIL throws its stars: a burst of the glitter's four-point stars as it
      // cools, then, at rest, one now and then off its edge.
      if (todayFoil) {
        const link = L.links[todayIndex];
        const struck = reach(todayIndex) + STRIKE_MS;
        const since = t - struck;
        if (since >= 0 && since < BURST_MS) {
          for (let s = 0; s < 5; s += 1) {
            // Up and out: never down into the initials.
            const a = Math.PI * (1.02 + (s / 4) * 0.96);
            const out = 7 + 6 * (since / BURST_MS);
            const life = sparkleAt((since / 1000) * 1.6 + hash3(s, 3, 41) * 0.15);
            star(put, Math.round(link.x + Math.cos(a) * out), Math.round(link.y + Math.sin(a) * out * 0.75), life, s % 2 === 0);
          }
        } else if (since >= BURST_MS) {
          const period = 2.8;
          const local = seconds + 0.9;
          const cycle = Math.floor(local / period);
          const age = local - cycle * period;
          const a = Math.PI * (1.05 + hash3(cycle, 7, 43) * 0.9);
          const x = Math.round(link.x + Math.cos(a) * (LINK_W / 2 + 1));
          const y = Math.round(link.y + Math.sin(a) * (LINK_H / 2 + 1));
          star(put, x, y, sparkleAt(age), hash3(cycle, 8, 43) > 0.5);
        }
      }

      // A faint cobalt EMBER drifts off the pilot now and then — the zero is waiting, not dead.
      if (!lit) {
        const period = 1.9;
        const cycle = Math.floor(seconds / period);
        const age = (seconds - cycle * period) / period;
        if (age < 0.6) {
          const rise = age / 0.6;
          const ex = L.crown.x - 0.5 + (hash3(cycle, 1, 51) - 0.5) * 3 + Math.sin(seconds * 3) * rise;
          const ey = L.crown.y - 4 - rise * 7;
          put(ex, ey, rise < 0.4 ? COBALT : DEEP);
        }
      }
    },
  };
}
