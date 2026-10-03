import { easeOutCubic } from '../../hooks/useAnimatedNumber';
import { T0, hash3, noise3 } from '../noise';
import { sparkleAt } from '../foil';
import {
  CLIMB_MS,
  CLOSE_MS,
  COMET_MS,
  COOL_MS,
  GLINT_MS,
  HEARTBEAT_AFTER_MS,
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_MS,
  LIT_FLASH_MS,
  ORBIT_DELAY_MS,
  ORBIT_EXPAND_MS,
  ORBIT_STAGGER_MS,
  PULSE_STEP_MS,
  SHOCK_MS,
  SHOW_STEP_MS,
  STRIKE_FLASH_MS,
  WAVE_FLASH_MS,
  WAVE_STEP_MS,
  WEEK_SWEEP_MS,
  WRAP_SWEEP_MS,
  at,
  backOut,
  clamp01,
  easeInOutSine,
  smooth,
  type Timeline,
} from './beats';
import {
  COBALT,
  DEEP,
  FOIL,
  INKS,
  LINK_H,
  LINK_W,
  RAIL,
  WHITE,
  flame,
  shade,
  star,
  type Put,
} from './sprites';
import { pastOrbits, ringXY, scaledRing, type Layout, type NumberCells, type Ring } from './geometry';
import { measureField, type ClearRect, type LinkCell } from './field';
import { countLayer } from './count';

// THE STREAK'S ORBIT, WITH ITS CHAIN — the celebration's picture, drawn the way the link
// previews draw theirs: bare ground, ONE big subject in whole cells, dithered orbit trails
// around it.
//
//   THE NUMBER at the centre — the pixel face's own digits (`assets/digits.png`), each glyph
//     pixel a whole square of cells: 120px on a phone, the share card's 160 on a desktop,
//     and never smaller at 100 than at 10.
//   THE WEEK under it as a CHAIN, Monday first, left to right — the calendar's grammar (a
//     solved day linked to the solved day beside it) drawn as metal: one upright face-on LINK
//     for each day, an edge-on link threaded through the holes of two solved neighbours. A
//     day to come is the link's empty ghost, a day missed an iron link left open. The chain
//     IS the front of the WEEK'S ORBIT, the loop the number sits in: it lies along its floor
//     (`chainPlacement`), the loop running on out of the two end links with no corner. The
//     initials stand on one line under the chain. The orbit carries the week round, over the
//     top, from Sunday back to Monday, and where it turns, at the top, burns
//   THE CROWN — a small flame in the solve's cobalt and white, lit by the landing's shock and
//     flared by today's light, which runs round the orbit to it (THE RELAY).
//   TODAY'S LINK is FORGED on screen: it pours in white-hot while the old count heats, waits
//     molten while the count lands, is struck (the ultra star) as the chain reaches it, and
//     cools cell by cell into the holographic FOIL — the one shiny thing. Its light runs back
//     down the chain and lights every earlier link from iron to cobalt, nearest first.
//   THE PAST WEEKS around it all — one orbit for each earlier week the run has crossed, in
//     cobalt, thinning and cooling to DEEP with age: a run begun this week draws none, a
//     hundredth day the whole field. The orbits MEAN the streak; they never wear the heat
//     ramp, which means distance.
//
// A scene in the tutorial art's grammar (`tutorial/art/scenes/kit.ts`): ink INDICES into a
// raster of cells (0 = the ground, left transparent), deterministic in `t` — the time since
// the celebration began (`beats.ts`) — so a frame is the same on every device, the
// fast-forward is just a later `t`, and reduced motion is one `t` held. The FOIL is an ink
// whose colour is a function of the cell and the clock (`foilInk`), so the dialog paints it
// per cell; the ULTRA star is a sheet the dialog lays over the raster; the words over it move
// on the same `t` (`wordsAt`). Where everything stands is `geometry.ts`; the cells it all
// lands on are measured once (`field.ts`); the count is its own layer (`count.ts`); the
// small drawn things are `sprites.ts`.

// ── The week, as the scene reads it ──────────────────────────────────────────────────────
export interface OrbitDay {
  solved: boolean; // solved BEFORE today's solve (today's own is drawn by the beats)
  today: boolean;
  future: boolean;
}

export interface OrbitScene {
  inks: readonly string[];
  // `foil`, when given, receives each FOIL cell's place on its link's diagonal and its link's
  // phase along the loop (see foilInk).
  draw(ink: Uint8Array, t: number, foil?: FoilField): void;
}

export interface FoilField {
  u: Float32Array;
  phase: Float32Array;
}

export interface OrbitInput {
  L: Layout;
  days: readonly OrbitDay[]; // exactly 7, Monday first
  from: NumberCells;
  to: NumberCells;
  weeks: number; // past weeks the run crossed (pastWeeks); the orbits drawn are capped by the layout
  carriesIn: boolean; // the run reaches Monday from last week
  closes: boolean; // today completes the week (see Timeline.close)
  clear: readonly ClearRect[]; // cells the orbits leave bare (the words, the frame)
  tl: Timeline;
}

// The charge's gather: sparks drawn in off the week's orbit onto the count.
const GATHER_SPARKS = 22;
const TAU = Math.PI * 2;

export function orbitScene(input: OrbitInput): OrbitScene {
  const { L, days, from, to, weeks, carriesIn, closes, clear, tl } = input;
  const { cols, rows, cx, k, ring, links } = L;
  const todayIndex = days.findIndex((d) => d.today);
  const hasComet = todayIndex > 0 && days[todayIndex - 1].solved;
  const ccy = L.countCy;
  const material = (i: number) => days[i].solved || days[i].today;
  const missed = (i: number) => !days[i].solved && !days[i].today && !days[i].future;

  // The past weeks' orbits: each a few TRAILS, dense at the head and thinning to the tail,
  // drifting round at its own speed, alternate orbits counter-turning; the older the week,
  // the thinner its stroke and the more of its cobalt cools to DEEP.
  const orbits = pastOrbits(L, weeks).map((ringOf, i) => {
    // The last week's orbit carries four trails resting about its top and its foot — where
    // a phone, whose frame the outer orbits' sides run out of, shows them; each older orbit two,
    // turned by the golden angle from the one inside it, so no two line up into hatching.
    const centres =
      i === 0
        ? [-Math.PI / 2 - 0.62, -Math.PI / 2 + 0.5, Math.PI / 2 - 0.55, Math.PI / 2 + 0.66]
        : [0, 1].map((a) => i * 2.39996 + 0.35 + Math.PI * a);
    return {
      ring: ringOf,
      width: i === 0 ? 0.8 : 0.6,
      peak: 0.9 - 0.08 * i,
      cool: 0.1 + 0.16 * i, // the share of a trail's cells in DEEP
      dir: i % 2 === 0 ? 1 : -1,
      speed: 0.045 + 0.02 * hash3(i, 2, 11),
      trails: centres.map((c, a) => {
        const span = i === 0 ? 0.5 + 0.45 * hash3(i, a, 13) : 0.6 + 0.4 * hash3(i, a, 13);
        return { c: c + 0.4 * (hash3(i, a, 12) - 0.5), span };
      }),
      start: tl.impact + ORBIT_DELAY_MS + i * ORBIT_STAGGER_MS,
    };
  });

  // The count: the old one and the new, the landing chip and its light.
  const count = countLayer(L, from, to, tl);
  const { chipR } = count;

  // The cells, measured once: a frame then only reads.
  const field = measureField(L, clear);
  const { n, TH, R, CLEAR, WORDS, maxR, withinRadius, path, cellAlong, reachAlong } = field;
  const { weekBand, bandS, bandOff, pointAt, tailFrom, seenA, cover, hole, nearLink, linkCells } = field;
  const { dayAlong, weekEnd, crownAlong } = path;
  const todayLink = todayIndex >= 0 ? links[todayIndex] : null;

  // WHEN THE LIGHT REACHES a place on the chain (ms): the run leaves today's link after
  // RUN_DELAY_MS and takes PULSE_STEP_MS a link back toward Monday — then, off Monday, climbs
  // the orbit's left side to the crown in CLIMB_MS. Infinity where it never goes (right of
  // today: those days are still to come).
  const sT = todayIndex >= 0 ? dayAlong[todayIndex] : 0;
  // One day's step along the chain (the path is longer than the pitch where the arc leans).
  const pitchAlong = todayIndex > 0 ? sT / todayIndex : L.pitch * cellAlong;
  const climbFrom = tl.run + Math.max(0, todayIndex) * PULSE_STEP_MS;
  const litAt = (sv: number): number => {
    if (todayIndex < 0) return Infinity;
    if (sv <= sT + 1e-9) return tl.run + ((sT - sv) / pitchAlong) * PULSE_STEP_MS;
    if (sv >= crownAlong) return climbFrom + CLIMB_MS * clamp01((1 - sv) / (1 - crownAlong));
    return Infinity;
  };
  const linkLit = links.map((_, i) => (i < todayIndex ? litAt(dayAlong[i]) : Infinity));
  // A full week's foil, from Monday along the chain (today's is its own).
  const waveAt = (sv: number) =>
    tl.wave === null ? Infinity : sv >= sT - 1e-9 ? tl.light : tl.wave + (sv / pitchAlong) * WAVE_STEP_MS;
  const linkWave = links.map((_, i) => (i === todayIndex ? Infinity : waveAt(dayAlong[i])));
  // The idle glint runs over the chain's own cobalt (and a full week's foil): its earlier
  // links and the edge-on links between them.
  const glintCells: { i: number; s: number }[] = [];
  for (let li = 0; li < 7; li += 1)
    if (li < todayIndex || (closes && li !== todayIndex)) for (const c of linkCells[li]) glintCells.push({ i: c.i, s: c.s });
  for (const i of weekBand) {
    const sv = bandS[i];
    if (sv < sT && Math.abs(bandOff[i]) < 1.05 && cover[i] < 0) glintCells.push({ i, s: sv });
  }

  // TODAY'S LINK, cell by cell: the slot (its ghost), poured white-hot from the bottom up,
  // molten, struck white, then cooled into the foil in the dither's order.
  const forge = (c: LinkCell, t: number): number => {
    // Before the pour: the slot, the link's empty ghost.
    if (t < tl.light) {
      const ignite = tl.pour + (tl.impact - tl.pour) * 0.86 * (0.55 * c.order + 0.45 * c.rise);
      const age = t - ignite;
      if (age < 0) return c.ghost ? RAIL : 0;
      if (age < 90) return WHITE;
      // Molten: cobalt, cells catching white frame to frame.
      return hash3(c.x, c.y, Math.floor(t / SHOW_STEP_MS)) < 0.14 ? WHITE : COBALT;
    }
    // STRUCK: white, then cooling into the foil cell by cell in the dither's order.
    const since = t - tl.light;
    if (since < STRIKE_FLASH_MS) return WHITE;
    if ((since - STRIKE_FLASH_MS) / COOL_MS <= c.order) return WHITE;
    return FOIL;
  };

  return {
    inks: INKS,
    draw(ink, t, foil) {
      const put: Put = (x, y, v) => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) return;
        ink[yi * cols + xi] = v;
      };
      // An effect's cell: off the words and the frame.
      const fx: Put = (x, y, v) => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) return;
        const i = yi * cols + xi;
        if (WORDS[i]) return;
        ink[i] = v;
      };
      // A trail along an orbit (the week's shape, grown): head at angle `head`, `spanA` long,
      // running `dir`; a stroke `width` cells across, its cells lit where their threshold is
      // under the trail's density there — `peak` at the head, a tenth of it at the tail.
      const trail = (
        r: Ring,
        head: number,
        spanA: number,
        dir: number,
        width: number,
        peak: number,
        v: (u: number, i: number) => number,
      ) => {
        const steps = Math.ceil((spanA * Math.max(r.rx, r.ry, r.ryL)) / 0.35);
        for (let s = 0; s <= steps; s += 1) {
          const u = s / steps;
          const a = head - dir * spanA * (1 - u);
          const [X, Y] = ringXY(r, a);
          const px = cx + X;
          const py = r.cy + Y;
          if (px < -2 || py < -2 || px > cols + 2 || py > rows + 2) continue;
          // The outward normal, off the curve's own tangent.
          const [X0, Y0] = ringXY(r, a - 0.002);
          const [X1, Y1] = ringXY(r, a + 0.002);
          let nx = Y1 - Y0;
          let ny = X0 - X1;
          const nl = Math.hypot(nx, ny) || 1;
          nx /= nl;
          ny /= nl;
          if (nx * X + ny * Y < 0) {
            nx = -nx;
            ny = -ny;
          }
          const d = peak * (0.1 + 0.9 * u ** 1.6);
          for (let w = -width / 2; w <= width / 2 + 1e-6; w += 0.5) {
            const xi = Math.floor(px + nx * w);
            const yi = Math.floor(py + ny * w);
            if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) continue;
            const i = yi * cols + xi;
            const tv = TH[i];
            if (tv < d && tv >= CLEAR[i]) ink[i] = v(u, i);
          }
        }
      };
      // A whole orbit, one cell wide, cobalt at an even density.
      const loop = (r: Ring, d: number) => {
        const steps = Math.ceil((TAU * Math.max(r.rx, r.ry, r.ryL)) / 0.3);
        for (let s = 0; s < steps; s += 1) {
          const [X, Y] = ringXY(r, (TAU * s) / steps);
          const xi = Math.floor(cx + X);
          const yi = Math.floor(r.cy + Y);
          if (xi < 0 || yi < 0 || xi >= cols || yi >= rows) continue;
          const i = yi * cols + xi;
          if (TH[i] < d && TH[i] >= CLEAR[i] && cover[i] < 0) ink[i] = COBALT;
        }
      };
      const seconds = t / 1000;

      // ── 1. THE HEARTBEAT, once everything has landed: a faint cobalt pulse out of the
      // week's orbit every few seconds, as the glint down the chain reaches Monday — the
      // streak alive, not a loop of the landing.
      const beatAge = t - tl.settled - HEARTBEAT_AFTER_MS;
      const beatPhase = beatAge >= 0 ? beatAge % HEARTBEAT_EVERY_MS : -1;
      const beat = beatPhase >= GLINT_MS * 0.8 ? (beatPhase - GLINT_MS * 0.8) / HEARTBEAT_MS : 2;
      if (beat < 1) {
        const grow = 1 + 1.4 * easeOutCubic(beat);
        const d = 0.3 * (1 - beat) ** 1.5;
        loop(scaledRing(ring, grow), d);
      }

      // ── 2. THE PAST WEEKS: bursting out of the chip as trails, white-hot, overshooting
      // to their rest and cooling to their cobalt; then drifting.
      for (let o2 = 0; o2 < orbits.length; o2 += 1) {
        const o = orbits[o2];
        if (t < o.start) continue;
        const p = at(t, o.start, ORBIT_EXPAND_MS);
        const sigma = p >= 1 ? 1 : (chipR / o.ring.ry) * 0.9 + (1 - (chipR / o.ring.ry) * 0.9) * backOut(p);
        const hot = p < 0.12 ? 2 : p < 0.3 ? 1 : 0;
        const v =
          hot === 2
            ? () => WHITE
            : hot === 1
              ? (_u: number, i: number) => (TH[i] < 0.35 ? WHITE : COBALT)
              : (u: number, i: number) => (TH[i] > 1 - o.cool * (1.4 - u) ? DEEP : COBALT);
        for (const tr of o.trails) {
          // The head leads the trail's centre by half its span, in the orbit's direction.
          const head = tr.c + o.dir * (tr.span / 2 + o.speed * seconds);
          trail(sigma === 1 ? o.ring : scaledRing(o.ring, sigma), head, tr.span, o.dir, o.width, o.peak, v);
        }
      }

      // ── 3. THE SHOCK: one thin white front racing out of the chip to the corners, cooling
      // to cobalt, and a sparse cobalt wake behind it.
      const shock = at(t, tl.impact, SHOCK_MS);
      if (shock > 0 && shock < 1) {
        const shockR = chipR + (maxR - chipR) * easeOutCubic(shock);
        const fade = (1 - shock) ** 1.2;
        const wake = Math.max(4, Math.min(9, (maxR - chipR) * 0.05));
        const front = shock < 0.25 ? -1 : 0;
        withinRadius(shockR - wake, shockR + 1, (i) => {
          const tv = TH[i];
          if (tv < CLEAR[i]) return;
          const d = R[i] - shockR;
          if (d > front) {
            if (tv < fade) ink[i] = shock < 0.3 ? WHITE : COBALT;
          } else if (tv < fade * 0.16 * (1 + d / wake)) ink[i] = COBALT;
        });
      }

      // ── 4. THE WEEK'S ORBIT and the chain's EDGE-ON LINKS ──────────────────────────────
      // The week draws itself left to right; then the orbit climbs from both its ends to the
      // crown, where the pilot waits. Between two solved days the edge-on link: a flat bar,
      // its lit face over its under-face, threaded through both holes — it shows BAR_REACH
      // cells into each, and the face-on links (drawn after) pass in front of it.
      const sweep = weekEnd * easeOutCubic(at(t, tl.orbitIn, WEEK_SWEEP_MS));
      const wrapIn = easeOutCubic(at(t, tl.orbitIn + WEEK_SWEEP_MS * 0.6, WRAP_SWEEP_MS)) / 2;
      const comet = hasComet ? at(t, tl.comet, COMET_MS) : 0;
      const lit = t >= tl.light;
      const cooled = t >= tl.light + STRIKE_FLASH_MS + COOL_MS;
      const close = closes && tl.close !== null ? at(t, tl.close, CLOSE_MS) : 0;
      const segOf = (sv: number) => {
        let j = 0;
        while (j < 5 && sv >= dayAlong[j + 1]) j += 1;
        return j;
      };
      // An edge-on link's cell, lit by the run at `litTime`, foil from `foilTime`. Its end
      // inside a hole is in the link's shadow: it never flashes white there (a white nub in a
      // hole reads as an eye, or a clock's hand).
      const bar = (i: number, seg: number, off: number, litTime: number, foilTime: number) => {
        let v: number;
        if (t >= foilTime) v = t < foilTime + WAVE_FLASH_MS ? WHITE : FOIL;
        else if (t < litTime) v = RAIL;
        else v = t < litTime + LIT_FLASH_MS ? WHITE : COBALT;
        if (v === WHITE && hole[i]) v = COBALT;
        ink[i] = off < 0 ? v : shade(v);
        if (v === FOIL && foil) {
          foil.u[i] = (bandS[i] - dayAlong[seg]) / (dayAlong[seg + 1] - dayAlong[seg]);
          foil.phase[i] = (seg + 0.5 - todayIndex) * 0.17;
        }
      };
      for (let j = 0; j < weekBand.length; j += 1) {
        const i = weekBand[j];
        const sv = bandS[i];
        const off = bandOff[i];
        const flat = off >= -1 && off < 1;
        if (sv <= weekEnd) {
          if (sv > sweep) continue;
          const seg = segOf(sv);
          if (material(seg) && material(seg + 1)) {
            if (!flat || sv < dayAlong[seg] + reachAlong || sv > dayAlong[seg + 1] - reachAlong) continue;
            if (seg + 1 === todayIndex) {
              // INTO TODAY: the comet forges it, white-hot behind its head; struck with today,
              // it cools with it.
              const reach = (sv - dayAlong[seg]) / (dayAlong[seg + 1] - dayAlong[seg]);
              if (!lit && (!hasComet || reach > comet)) continue;
              const hot = !lit ? comet - reach < 0.3 : !cooled;
              const foilTime = tl.wave === null ? Infinity : Math.max(linkWave[seg], tl.light);
              if (t >= foilTime) bar(i, seg, off, 0, foilTime);
              else ink[i] = hot && !hole[i] ? WHITE : off < 0 ? COBALT : DEEP;
            } else {
              bar(i, seg, off, litAt(sv), Math.max(linkWave[seg], linkWave[seg + 1]));
            }
          } else if (!missed(seg) && !missed(seg + 1) && Math.abs(off) < 0.55 && TH[i] < 0.5 && cover[i] < 0 && !nearLink[i]) {
            // Toward the days to come, the orbit's own dotted rail; none touches a missed day.
            ink[i] = RAIL;
          }
        } else {
          const u = (sv - weekEnd) / (1 - weekEnd); // 0 at Sunday, about ½ at the crown, 1 at Monday
          const inLinks = sv < weekEnd + reachAlong || sv > 1 - reachAlong;
          if (close > 0 && u <= close) {
            // THE ORBIT CLOSES: the light runs on from Sunday, round the crown, into Monday, and
            // leaves the orbit drawn whole — one solid cell, a line where the rail was dotted.
            if (off < -1 || off >= 0 || inLinks) continue;
            ink[i] = close < 1 && close - u < 0.06 && !hole[i] ? WHITE : COBALT;
          } else if (carriesIn && days[0].solved && u > tailFrom && flat && !inLinks) {
            // The run came in from last week: the chain enters Monday from beyond the frame's
            // edge (or the orbit's turn), dithering out the farther it is from Monday; lit by
            // the run like the links it leads into.
            const d = ((u - tailFrom) / (1 - tailFrom)) ** 0.8 * at(t, tl.orbitIn, WEEK_SWEEP_MS * 0.5);
            if (TH[i] < d) {
              const v = t >= litAt(sv) ? COBALT : RAIL;
              ink[i] = off < 0 ? v : shade(v);
            }
          } else if ((u <= wrapIn || u >= 1 - wrapIn) && Math.abs(off) < 0.5 && TH[i] < 0.3 && cover[i] < 0 && !nearLink[i]) {
            // The rest of the orbit, a faint dotted rail.
            ink[i] = RAIL;
          }
        }
      }

      // THE COMET's head, shedding sparks behind it as it runs into today.
      if (hasComet && comet > 0 && !lit) {
        const head = pointAt(dayAlong[todayIndex - 1] + (dayAlong[todayIndex] - dayAlong[todayIndex - 1]) * comet);
        // Behind the links: the head and its sparks never show in a hole.
        const air: Put = (x, y, v) => {
          const xi = Math.floor(x);
          const yi = Math.floor(y);
          if (xi >= 0 && yi >= 0 && xi < cols && yi < rows && cover[yi * cols + xi] < 0) fx(x, y, v);
        };
        for (let y = 0; y < 2; y += 1) for (let x = 0; x < 2; x += 1) air(head.x - 1 + x, head.y - 1 + y, WHITE);
        const frame = Math.floor(t / SHOW_STEP_MS);
        for (let k2 = 0; k2 < 5; k2 += 1) {
          const back = 2 + hash3(k2, frame, 51) * 7 * comet;
          const side = (hash3(k2, frame, 52) - 0.5) * 6;
          air(head.x - back, head.y + side - back * 0.15, hash3(k2, frame, 53) < 0.45 ? WHITE : COBALT);
        }
      }

      // THE RELAY: today's light runs round the orbit both ways — back down the chain (the
      // run, lighting it) and on up the left side, and up through the days to come and the
      // right side — and the two meet at the crown, which flares.
      if (tl.relay !== null && todayIndex >= 0 && t >= tl.relay && t < tl.flare + SHOW_STEP_MS) {
        const tail = 0.05;
        // The left head: where the run has got to (its place, decreasing from today, wrapping).
        const ranMs = t - tl.run;
        const leftD =
          ranMs <= climbFrom - tl.run
            ? (ranMs / PULSE_STEP_MS) * pitchAlong
            : sT + (1 - crownAlong) * clamp01((t - climbFrom) / CLIMB_MS);
        const rightD = (crownAlong - sT) * easeInOutSine(at(t, tl.relay, tl.flare - tl.relay));
        for (let j = 0; j < weekBand.length; j += 1) {
          const i = weekBand[j];
          if (cover[i] >= 0) continue;
          const off = Math.abs(bandOff[i]);
          if (off > 1.05) continue;
          const sv = bandS[i];
          const dl = sv <= sT ? sT - sv : sT + 1 - sv;
          const dr = sv - sT;
          let behind = 2;
          if (dl >= 0 && dl <= leftD + 0.01) behind = Math.min(behind, (leftD - dl) / tail);
          if (dr >= 0 && dr <= crownAlong - sT && dr <= rightD + 0.01) behind = Math.min(behind, (rightD - dr) / tail);
          if (behind > 1) continue;
          if (behind < 0.18) ink[i] = WHITE;
          else if (off < 0.6 && TH[i] < 1 - behind && ink[i] === 0) ink[i] = COBALT;
        }
      }

      // ── 5. TODAY'S HEAT: a dithered halo round its link while it is hot — light drawn the
      // pixel way, round the metal (never inside its hole), gone once it has cooled.
      if (todayLink) {
        const heat =
          t < tl.pour
            ? 0
            : t < tl.impact
              ? smooth((t - tl.pour) / (tl.impact - tl.pour))
              : t < tl.light
                ? 1
                : 1 - smooth((t - tl.light) / (STRIKE_FLASH_MS + COOL_MS));
        if (heat > 0) {
          const hx = LINK_W / 2 + 6;
          const hy = LINK_H / 2 + 6;
          for (let y = Math.floor(todayLink.y - hy); y <= todayLink.y + hy; y += 1) {
            for (let x = Math.floor(todayLink.x - hx); x <= todayLink.x + hx; x += 1) {
              if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
              const i = y * cols + x;
              if (cover[i] >= 0 || ink[i] !== 0) continue;
              const d = Math.hypot((x + 0.5 - todayLink.x) / hx, (y + 0.5 - todayLink.y) / hy);
              if (d >= 1) continue;
              const flicker = 0.7 + 0.3 * noise3(x * 0.35, y * 0.35, T0 + t * 0.006);
              const density = heat * 0.8 * (1 - d) ** 1.2 * flicker;
              if (TH[i] < density && !WORDS[i]) ink[i] = density > 0.42 ? COBALT : DEEP;
            }
          }
        }
      }

      // ── 6. THE LINKS ────────────────────────────────────────────────────────────────────
      // Each dithers in as the sweep reaches it. An earlier solved day is iron until the run
      // lights it (white, then cobalt); a day to come is its empty ghost, dashed in iron; a
      // day missed an iron link left open; today is forged.
      const sweepP = easeOutCubic(at(t, tl.orbitIn, WEEK_SWEEP_MS));
      const linkSpan = LINK_W * cellAlong;
      for (let li = 0; li < 7; li += 1) {
        const day = days[li];
        const appear = clamp01((sweepP * (weekEnd + linkSpan) - dayAlong[li]) / linkSpan);
        if (appear <= 0) continue;
        const phase = (li - todayIndex) * 0.17;
        for (const c of linkCells[li]) {
          if (appear < 1 && c.order >= appear) continue;
          let v: number;
          if (day.today) v = forge(c, t);
          else if (day.solved) {
            const w = linkWave[li];
            const l2 = linkLit[li];
            if (t >= w) v = t < w + WAVE_FLASH_MS ? WHITE : FOIL;
            else v = t < l2 ? RAIL : t < l2 + LIT_FLASH_MS ? WHITE : COBALT;
          } else if (day.future) {
            v = c.ghost ? RAIL : 0;
          } else {
            v = c.cut ? 0 : RAIL;
          }
          if (v === 0) continue;
          ink[c.i] = c.deep ? shade(v) : v;
          if (v === FOIL && foil) {
            foil.u[c.i] = c.u;
            foil.phase[c.i] = phase;
          }
        }
      }

      // ── 7. THE FORGE'S SPARKS: embers rising off the link while it pours and waits molten,
      // then the strike's eight streaks.
      if (todayLink && t >= tl.pour && t < tl.light) {
        for (let e = 0; e < 18; e += 1) {
          const life = 360 + hash3(e, 2, 61) * 300;
          // Each ember loops on its own life, from the pour until the strike.
          const local = t - tl.pour - 60 - hash3(e, 1, 61) * 600;
          if (local < 0) continue;
          const cycle = Math.floor(local / life);
          const age = local - cycle * life;
          const a = hash3(e, 3 + cycle, 61) * TAU;
          const ox = todayLink.x + Math.cos(a) * (LINK_W / 2 - 0.5);
          const oy = todayLink.y + Math.sin(a) * (LINK_H / 2 - 0.5);
          const x = ox + (hash3(e, 5 + cycle, 61) - 0.5) * 0.014 * age + Math.sin(age * 0.012 + e) * 0.8;
          const y = oy - (0.016 + hash3(e, 4 + cycle, 61) * 0.022) * age;
          const f = age / life;
          const i = Math.floor(y) * cols + Math.floor(x);
          if (i >= 0 && i < n && cover[i] >= 0) continue;
          fx(x, y, f < 0.3 ? WHITE : f < 0.7 ? COBALT : DEEP);
        }
      }
      const hit = t - tl.light;
      if (todayLink && hit >= 0 && hit < 340) {
        const p = hit / 340;
        const reach = 8 + 12 * (1 - (1 - p) ** 2);
        const len = p < 0.5 ? 3 : p < 0.8 ? 2 : 1;
        const v = p < 0.45 ? WHITE : COBALT;
        for (let s = 0; s < 8; s += 1) {
          const a = (s / 8) * TAU + Math.PI / 8;
          for (let j = 0; j < len; j += 1) {
            const x = Math.floor(todayLink.x + Math.cos(a) * (reach - j));
            const y = Math.floor(todayLink.y + Math.sin(a) * 0.9 * (reach - j));
            // Through the air, never over a link.
            if (x >= 0 && y >= 0 && x < cols && y < rows && cover[y * cols + x] < 0) fx(x, y, v);
          }
        }
      }

      // ── 8. THE IDLE GLINT: once settled, light leaves today's foil and runs back down the
      // chain, lifting each cell a step (cobalt to white, deep to cobalt, foil to white).
      if (beatPhase >= 0 && beatPhase < GLINT_MS && todayIndex > 0) {
        const head = sT - (beatPhase / GLINT_MS) * (sT + 3 * cellAlong);
        for (const g of glintCells) {
          const d = (g.s - head) / cellAlong;
          if (d < 0 || d >= 4) continue;
          const v = ink[g.i];
          if ((v === COBALT || v === FOIL) && d < 2.2) ink[g.i] = WHITE;
          else if (v === DEEP) ink[g.i] = COBALT;
        }
      }

      // ── 9. THE GATHER: during the charge, sparks fall in off the week's orbit onto the
      // count — the breath before the landing.
      if (t >= tl.charge && t < tl.impact) {
        const p = (t - tl.charge) / (tl.impact - tl.charge);
        for (let s = 0; s < GATHER_SPARKS; s += 1) {
          const late = 0.45 * hash3(s, 1, 41);
          const q = clamp01((p - late) / (1 - late));
          if (q <= 0) continue;
          // Off the orbit where it is on screen: its top or its foot.
          const a = (hash3(s, 3, 41) < 0.5 ? -1 : 1) * (seenA + (Math.PI - 2 * seenA) * hash3(s, 2, 41));
          const [oX, oY] = ringXY(ring, a);
          const sx = cx + oX * 0.96;
          const sy = ring.cy + oY * 0.96;
          const ex = cx + Math.cos(a) * chipR * 0.5;
          const ey = ccy + Math.sin(a) * chipR * 0.3;
          const e = q * q;
          const x = sx + (ex - sx) * e;
          const y = sy + (ey - sy) * e;
          // A short tail back along its fall.
          const bx = sx + (ex - sx) * Math.max(0, e - 0.08);
          const by = sy + (ey - sy) * Math.max(0, e - 0.08);
          put(bx, by, COBALT);
          put(x, y, WHITE);
        }
      }

      // ── 10. THE GLITTER: four-point stars in the air round today's foil (round the whole
      // chain once a full week is foil), each on its own clock, landing somewhere new each
      // time — whole or not at all, never on a link or a word.
      if (todayLink && t >= tl.light + STRIKE_FLASH_MS) {
        const full = tl.wave !== null && t >= tl.wave + 6 * WAVE_STEP_MS;
        const open = (x: number, y: number) =>
          x >= 0 &&
          y >= 0 &&
          x < cols &&
          y < rows &&
          ink[y * cols + x] === 0 &&
          !WORDS[y * cols + x] &&
          cover[y * cols + x] < 0;
        const clearAt = (x: number, y: number) => {
          for (let a = -2; a <= 2; a += 1) if (!open(x + a, y) || !open(x, y + a)) return false;
          return true;
        };
        const placed: number[] = [];
        const apart = (x: number, y: number) => {
          for (let j = 0; j < placed.length; j += 2) if (Math.abs(placed[j] - x) < 5 && Math.abs(placed[j + 1] - y) < 5) return false;
          return true;
        };
        const slots = full ? 12 : 6;
        for (let s = 0; s < slots; s += 1) {
          const period = 2.4;
          const local = (t - tl.light) / 1000 + hash3(s, 5, 21) * period - (s === 0 ? 0.2 : 0);
          if (local < 0) continue;
          const cycle = Math.floor(local / period);
          const age = local - cycle * period;
          const life = sparkleAt(age);
          if (life <= 0) continue;
          const around = full ? links[Math.floor(hash3(s, cycle, 26) * 7)] : todayLink;
          for (let tries = 0; tries < 2; tries += 1) {
            const a = TAU * hash3(s, cycle, 22 + tries);
            const r = 0.55 + 0.45 * hash3(s, cycle, 23 + tries);
            const x = Math.round(around.x + Math.cos(a) * (LINK_W / 2 + 3 + r * 5));
            const y = Math.round(around.y + Math.sin(a) * (LINK_H / 2 + 3 + r * 4));
            if (!clearAt(x, y) || !apart(x, y)) continue;
            star(put, x, y, life, hash3(s, cycle, 24) < 0.35);
            placed.push(x, y);
            break;
          }
        }
        // As each idle glint leaves today's link, three stars burst up off it.
        if (beatPhase >= 0 && beatPhase < 1000 && todayIndex > 0) {
          for (let s = 0; s < 3; s += 1) {
            const a = Math.PI * (1.15 + hash3(s, Math.floor(beatAge / HEARTBEAT_EVERY_MS), 27) * 0.7);
            const x = Math.round(todayLink.x + Math.cos(a) * 10);
            const y = Math.round(todayLink.y + Math.sin(a) * 8);
            if (clearAt(x, y)) star(put, x, y, sparkleAt(beatPhase / 1000 - s * 0.09), s % 2 === 0);
          }
        }
      }

      // ── 11. THE CROWN: a pilot spark at the top of the orbit, catching into the flame ───
      flame(put, L.crown, t, tl, seconds, closes);

      // ── 12. THE NUMBER ──────────────────────────────────────────────────────────────────
      count.draw(put, t);
    },
  };
}
