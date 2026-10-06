import { describe, expect, it } from 'vitest';
import { COUNT_ROWS, progressHeatColor } from '@whippin/shared';
import { rgbToAbgr } from '../raster';
import { BURST_ART } from '../strikeArt';
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
import { HEADROOM, calGeometry, keyAt, type CalGeometry } from './geometry';
import {
  keysBeats,
  keysScene,
  numberCells,
  sinkOf,
  type KeyState,
  type KeysModel,
  type KeysSpec,
} from './keysScene';

// The month's keys carry the archive's promises (the archive bullet of packages/web/AGENTS.md):
// a day under 100 is never drawn finished — its cap and light band stay iron, it never takes a
// run's link — while 1% still shows ink; a finished day is charged through and through, lit on
// top and dark at its foot, the other way up from a high %; a number never breaks into dither
// or slivers; a day not known yet is never drawn as one not started; a day OVER (ended
// unsolved) is its key SUNK — lower, out of the light, its number kept — never charged, linked
// or foiled; a day out of the window is a number and no key; runs join only finished days of one
// week, across a week's end only inside the month; and the one shiny thing is today's, only
// once it is done.

// The streak raster's inks, the scene's own.
const WHITE = inkAbgr(I_WHITE);
const MUTED = inkAbgr(I_MUTED);
const RAIL = inkAbgr(I_RAIL);
const COBALT = inkAbgr(I_COBALT);
const DEEP = inkAbgr(I_DEEP);
const GROUND = inkAbgr(I_GROUND);
const DUSK = inkAbgr(I_DUSK);
const heat = (pct: number) => rgbToAbgr(progressHeatColor(pct));

const G: CalGeometry = calGeometry(362, 844, true);
const W = G.keyW;
const H = G.keyH;

// A month: September 2026 laid out Monday-first (the 1st a Tuesday), each day's state given.
function month(state: (day: number) => KeyState, today = -1, phase: KeysModel['phase'] = 'data'): KeysModel {
  const keys: KeyState[] = [];
  for (let i = 0; i < 42; i += 1) {
    const day = i;
    keys.push(day >= 1 && day <= 30 ? state(day) : { kind: 'pad' });
  }
  return { keys, today, phase };
}
const SETTLED: Omit<KeysSpec, 'model'> = { build: null, drop: null, changes: [], digitsIn: false, ghostsIn: false, motion: true };

// The frame at `t` (settled, by default), and a reader of one key's cells.
function frame(model: KeysModel, spec: Partial<KeysSpec> = {}, t?: number, withFoil = true) {
  const tl = keysBeats({ ...SETTLED, ...spec, model });
  const scene = keysScene(G, model, tl, 3.5);
  const px = new Uint32Array(G.cols * G.rows);
  scene.draw(px, t ?? tl.settled + 5000, withFoil, -1);
  return { px, scene, tl };
}
const cell = (px: Uint32Array, i: number, lx: number, ly: number) => {
  const { x, y } = keyAt(G, i);
  return px[(y + ly) * G.cols + x + lx];
};
const corner = (lx: number, ly: number) => (lx === 0 || lx === W - 1) && (ly === 0 || ly === H - 1);
// The number's cells (1) and its ring (2), where the scene stands them.
const digitMap = (day: number) => numberCells(W, H, day);
const none = (day: number): KeyState => ({ kind: 'none', day });

// Every size the calendar lays its keys out at, one geometry each.
const SIZES: CalGeometry[] = [
  calGeometry(560, 1000, false),
  calGeometry(560, 657, false),
  calGeometry(362, 844, true),
  calGeometry(332, 800, true),
  calGeometry(292, 568, true),
  calGeometry(262, 653, true),
  calGeometry(536, 360, false),
];
// A settled frame at a size, and a reader of one key's cells there.
function frameAt(g: CalGeometry, model: KeysModel) {
  const tl = keysBeats({ ...SETTLED, model });
  const px = new Uint32Array(g.cols * g.rows);
  keysScene(g, model, tl, 3.5).draw(px, tl.settled + 5000, false, -1);
  return (i: number, lx: number, ly: number) => {
    const { x, y } = keyAt(g, i);
    return px[(y + ly) * g.cols + x + lx];
  };
}

describe('a day under 100 is never finished', () => {
  it('leaves the cap and the first light row iron at 99 — and at a rounded 100 — and takes no link', () => {
    for (const pct of [99, 100]) {
      // 10 at the % between two finished days.
      const model = month((d) => (d === 10 ? { kind: 'progress', day: d, pct } : d === 9 || d === 11 ? { kind: 'solved', day: d } : none(d)));
      const { px, tl } = frame(model);
      for (let lx = 1; lx < W - 1; lx += 1) {
        expect(cell(px, 10, lx, 0)).toBe(RAIL);
        expect([RAIL, DUSK]).toContain(cell(px, 10, lx, 1));
      }
      expect(tl.links.some((l) => l.a === 10 || l.b === 10)).toBe(false);
      // Nothing in the gaps either side of it.
      const { x, y } = keyAt(G, 10);
      for (let r = 0; r < H; r += 1) {
        for (let g = 1; g <= G.colGap; g += 1) {
          expect(px[(y + r) * G.cols + x - g]).toBe(0);
          expect(px[(y + r) * G.cols + x + W - 1 + g]).toBe(0);
        }
      }
    }
  });

  it('inks the whole foot row at 1%', () => {
    const { px } = frame(month((d) => (d === 15 ? { kind: 'progress', day: d, pct: 1 } : none(d))));
    for (let lx = 1; lx < W - 1; lx += 1) expect(cell(px, 15, lx, H - 1)).toBe(heat(1));
  });
});

describe("a played day's height is its %", () => {
  // Every day of the month at one %, settled, at a size.
  const allAt = (g: CalGeometry, pct: number) => frameAt(g, month((d) => ({ kind: 'progress', day: d, pct })));
  const DAYS = Array.from({ length: 30 }, (_, i) => i + 1);

  it('cuts every day at a % at the same edge, never lower at a higher %, its ink within two rows of the %', () => {
    expect(new Set(SIZES.map((g) => g.name)).size).toBe(7);
    const wrong: string[] = [];
    for (const g of SIZES) {
      const n = g.keyH - 1;
      const corners = (lx: number, ly: number) => (lx === 0 || lx === g.keyW - 1) && (ly === 0 || ly === g.keyH - 1);
      const maps = DAYS.map((day) => numberCells(g.keyW, g.keyH, day));
      let lastCut = 0;
      let lastTaken: Uint8Array[] | null = null;
      for (let pct = 1; pct <= 99; pct += 1) {
        const read = allAt(g, pct);
        const ink = heat(pct);
        // The %'s front: its share of the rows under the cap, never under 3, never past n − 4.
        const front = Math.min(n - 4, Math.max(3, (pct / 100) * n));
        const cuts = new Set<number>();
        const taken = DAYS.map((day, d) => {
          const m = maps[d];
          const at = `${g.name} ${pct}% day ${day}`;
          let cut = 0;
          // The cells the charge has taken: its ink, or a digit cut out of it.
          const cells = new Uint8Array(g.keyW * g.keyH);
          for (let ly = 0; ly < g.keyH; ly += 1) {
            const u = g.keyH - 1 - ly;
            let rowCut = false;
            for (let lx = 0; lx < g.keyW; lx += 1) {
              const v = read(day, lx, ly);
              const c = ly * g.keyW + lx;
              if (m[c] === 1 && v === GROUND) rowCut = true;
              cells[c] = v === ink || (m[c] === 1 && v === GROUND) ? 1 : 0;
              // More done never draws less: what the % below took, this one still takes.
              if (lastTaken && lastTaken[d][c] && !cells[c]) wrong.push(`${at}: lost cell ${lx},${ly}`);
              if (m[c] !== 0 || corners(lx, ly)) continue;
              // The face: solid two rows under the %'s solid ink, bare two rows over its front.
              if (u < front - 5 && v !== ink) wrong.push(`${at}: row ${ly} not solid`);
              if (u >= front + 2 && v === ink) wrong.push(`${at}: row ${ly} inked`);
            }
            if (rowCut) cut += 1;
          }
          cuts.add(cut);
          return cells;
        });
        // The edge is the %'s, never the digit's.
        const [cut] = cuts;
        if (cuts.size !== 1) wrong.push(`${g.name} ${pct}%: cut at ${[...cuts].join(', ')} rows`);
        else if (cut < lastCut) wrong.push(`${g.name} ${pct}%: cut lower than at ${pct - 1}%`);
        lastCut = cut;
        lastTaken = taken;
      }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it("stands no hat and no notch where the key leaves its number room: the ring is its row's ramp", () => {
    // From WIDE to REGULAR, the front finds a place within its two rows where every ring cell
    // agrees: ink only on a row a third inked or more, dusk only on one at most two thirds.
    // (On the smaller keys the number nearly fills the face, and the height wins.)
    const wrong: string[] = [];
    for (const g of SIZES.filter((s) => s.name === 'wide' || s.name === 'mid' || s.name === 'regular')) {
      const corners = (lx: number, ly: number) => (lx === 0 || lx === g.keyW - 1) && (ly === 0 || ly === g.keyH - 1);
      const maps = DAYS.map((day) => numberCells(g.keyW, g.keyH, day));
      for (let pct = 1; pct <= 99; pct += 1) {
        const read = allAt(g, pct);
        const ink = heat(pct);
        DAYS.forEach((day, d) => {
          const m = maps[d];
          for (let ly = 0; ly < g.keyH; ly += 1) {
            // The row's face: its cells in the key's shape, outside the number and its ring.
            let face = 0;
            let inked = 0;
            let inkRing = false;
            let duskRing = false;
            for (let lx = 0; lx < g.keyW; lx += 1) {
              const v = read(day, lx, ly);
              const dc = m[ly * g.keyW + lx];
              if (dc === 2) {
                inkRing ||= v === ink;
                duskRing ||= v === DUSK;
              } else if (dc === 0 && !corners(lx, ly)) {
                face += 1;
                if (v === ink) inked += 1;
              }
            }
            if (face < 4) continue;
            if (inkRing && inked / face < 1 / 3) wrong.push(`${g.name} ${pct}% day ${day} row ${ly}: a hat`);
            if (duskRing && inked / face > 2 / 3) wrong.push(`${g.name} ${pct}% day ${day} row ${ly}: a notch`);
          }
        });
      }
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });
});

describe('a finished day is charged through', () => {
  it('keeps its number band solid: no deep from its ring top to its ring foot, its last row deep, its foot darker than its top', () => {
    for (const g of SIZES) {
      const read = frameAt(g, month((d) => (d === 7 || d === 23 ? { kind: 'solved', day: d } : none(d))));
      for (const day of [7, 23]) {
        const m = numberCells(g.keyW, g.keyH, day);
        const ringRows = Array.from({ length: g.keyH }, (_, ly) => ly).filter((ly) =>
          m.subarray(ly * g.keyW, (ly + 1) * g.keyW).includes(2),
        );
        const top = ringRows[0];
        const foot = ringRows[ringRows.length - 1];
        const deep = (from: number, to: number) => {
          let n = 0;
          for (let ly = from; ly < to; ly += 1) for (let lx = 1; lx < g.keyW - 1; lx += 1) if (read(day, lx, ly) === DEEP) n += 1;
          return n / ((to - from) * (g.keyW - 2));
        };
        const at = `${g.name} day ${day}`;
        expect(deep(top, foot + 1), at).toBe(0);
        expect(deep(g.keyH - 1, g.keyH), at).toBe(1);
        expect(deep(foot + 1, g.keyH), at).toBeGreaterThan(deep(0, Math.floor(g.keyH / 2)));
      }
    }
  });

  it('inks every cell of its key cobalt or deep, its number cut out', () => {
    const { px } = frame(month((d) => (d === 12 ? { kind: 'solved', day: d } : none(d))));
    const m = digitMap(12);
    for (let ly = 0; ly < H; ly += 1) {
      for (let lx = 0; lx < W; lx += 1) {
        const v = cell(px, 12, lx, ly);
        if (corner(lx, ly)) expect(v).toBe(0);
        else if (m[ly * W + lx] === 1) expect(v).toBe(GROUND);
        else expect([COBALT, DEEP]).toContain(v);
      }
    }
    // Its foot is the deep: the last row whole.
    for (let lx = 1; lx < W - 1; lx += 1) expect(cell(px, 12, lx, H - 1)).toBe(DEEP);
  });

  it('is lit on top and dark at its foot — the other way up from a high %, whatever the hue', () => {
    const model = month((d) => (d === 12 ? { kind: 'solved', day: d } : d === 13 ? { kind: 'progress', day: d, pct: 87 } : none(d)));
    const { px } = frame(model);
    const share = (i: number, from: number, to: number, ink: (v: number) => boolean) => {
      let on = 0;
      let all = 0;
      for (let ly = from; ly < to; ly += 1) {
        for (let lx = 1; lx < W - 1; lx += 1) {
          all += 1;
          if (ink(cell(px, i, lx, ly))) on += 1;
        }
      }
      return on / all;
    };
    const top = Math.floor(H / 2);
    // Finished: its top half all lit cobalt; its lower half at least a third deep.
    expect(share(12, 0, 4, (v) => v === COBALT)).toBe(1);
    expect(share(12, top, H, (v) => v === DEEP)).toBeGreaterThan(1 / 3);
    // 87%: its top four rows are iron (no cobalt, no ink), its foot solid ink.
    expect(share(13, 0, 4, (v) => v === RAIL || v === DUSK)).toBe(1);
    expect(share(13, H - 3, H, (v) => v === heat(87))).toBe(1);
  });
});

describe('a number never breaks', () => {
  it('stands every digit cell whole (white or cut out) and its ring solid, at every %, settled or charging', () => {
    for (let pct = 1; pct <= 99; pct += 7) {
      const model = month((d) => (d === 23 ? { kind: 'progress', day: d, pct } : none(d)));
      const m = digitMap(23);
      const tl = keysBeats({ ...SETTLED, model, build: 'arrive' });
      const scene = keysScene(G, model, tl, 1);
      const px = new Uint32Array(G.cols * G.rows);
      for (const t of [tl.charge[23] + 100, tl.charge[23] + 180, tl.settled + 100]) {
        scene.draw(px, t, false, -1);
        for (let ly = 0; ly < H; ly += 1) {
          const row: number[] = [];
          for (let lx = 0; lx < W; lx += 1) {
            const v = cell(px, 23, lx, ly);
            if (m[ly * W + lx] === 1) {
              expect([WHITE, GROUND]).toContain(v);
              row.push(v);
            } else if (m[ly * W + lx] === 2) {
              expect([DUSK, heat(pct)]).toContain(v);
            }
          }
          // The hard edge: one row of a number is all one side of it.
          expect(new Set(row).size).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('never cuts a number into a sliver: three rows or more on each side of its edge, or none', () => {
    const m = digitMap(23);
    // The number's rows: each with a cell of its ink.
    const rows = Array.from({ length: H }, (_, ly) => ly).filter((ly) => m.subarray(ly * W, ly * W + W).includes(1));
    expect(rows).toHaveLength(COUNT_ROWS);
    for (let pct = 1; pct <= 99; pct += 1) {
      const model = month((d) => (d === 23 ? { kind: 'progress', day: d, pct } : none(d)));
      const { px } = frame(model);
      let cut = 0;
      for (const ly of rows) {
        const lx = m.subarray(ly * W, ly * W + W).indexOf(1);
        if (cell(px, 23, lx, ly) === GROUND) cut += 1;
      }
      expect([0, 3, 4, COUNT_ROWS]).toContain(cut);
    }
  });
});

describe('a day not known yet is never a day not started', () => {
  const unknown = (phase: KeysModel['phase']) => month((d) => ({ kind: 'unknown', day: d }), -1, phase);
  const density = (px: Uint32Array) => {
    let on = 0;
    for (let ly = 0; ly < H; ly += 1) for (let lx = 0; lx < W; lx += 1) if ([RAIL, MUTED].includes(cell(px, 8, lx, ly))) on += 1;
    return on;
  };

  it('draws no slate cap and no iron face', () => {
    for (const phase of ['loading', 'resting'] as const) {
      const { px } = frame(unknown(phase));
      const capRail = Array.from({ length: W - 2 }, (_, k) => cell(px, 8, k + 1, 0)).every((v) => v === RAIL);
      expect(capRail).toBe(false);
      for (let ly = 0; ly < H; ly += 1) for (let lx = 0; lx < W; lx += 1) expect(cell(px, 8, lx, ly)).not.toBe(DUSK);
      // …and keeps its number.
      const m = digitMap(8);
      for (let k = 0; k < m.length; k += 1) if (m[k] === 1) expect(cell(px, 8, k % W, Math.floor(k / W))).toBe(WHITE);
    }
  });

  it("keeps today's white cap on its ghost — still no slate one", () => {
    const { px } = frame(month((d) => ({ kind: 'unknown', day: d }), 8, 'resting'));
    for (let lx = 1; lx < W - 1; lx += 1) {
      expect(cell(px, 8, lx, 0)).toBe(WHITE);
      expect(cell(px, 8, lx, 1)).toBe(WHITE);
      expect(cell(px, 9, lx, 0)).not.toBe(WHITE);
    }
  });

  it('is sparser while the read is out than once it rests', () => {
    // (Off the wave's lit frames: the still pictures.)
    const loading = frame(unknown('loading'), { motion: false }).px;
    const resting = frame(unknown('resting')).px;
    expect(density(loading)).toBeLessThan(density(resting));
  });
});

describe('a day over (ended unsolved)', () => {
  const DAY = 14;
  // Day 14 over between two finished days (13 closes the week before, 15 shares its week).
  const overMonth = (today = -1) =>
    month((d) => (d === DAY ? { kind: 'over', day: d } : d === DAY - 1 || d === DAY + 1 ? { kind: 'solved', day: d } : none(d)), today);
  const noneMonth = (today = -1) =>
    month((d) => (d === DAY - 1 || d === DAY + 1 ? { kind: 'solved', day: d } : none(d)), today);
  // The key's top row: the first row holding a cell of it.
  const topRow = (read: (i: number, lx: number, ly: number) => number, g: CalGeometry, i: number) => {
    for (let ly = 0; ly < g.keyH; ly += 1) for (let lx = 0; lx < g.keyW; lx += 1) if (read(i, lx, ly) !== 0) return ly;
    return g.keyH;
  };
  const inkOf = (m: Uint8Array) => m.reduce((n, c) => n + (c === 1 ? 1 : 0), 0);

  it('is, at every size, its key SUNK a quarter of its height — unlit dusk, its number kept, muted', () => {
    for (const g of SIZES) {
      for (const today of [-1, DAY]) {
        const read = frameAt(g, overMonth(today));
        const bare = frameAt(g, noneMonth(today));
        const sink = sinkOf(g.keyH);
        const num = numberCells(g.keyW, g.keyH, DAY, sink);
        const at = `${g.name}${today === DAY ? ' today' : ''}`;
        expect(sink, at).toBe(Math.round(g.keyH / 4));
        // The number stands whole inside what stands of the key, its ring too.
        expect(inkOf(num), at).toBe(inkOf(numberCells(g.keyW, g.keyH, DAY)));
        for (let ly = 0; ly < sink; ly += 1) for (let lx = 0; lx < g.keyW; lx += 1) expect(num[ly * g.keyW + lx], at).toBe(0);
        let muted = 0;
        for (let ly = 0; ly < g.keyH; ly += 1) {
          for (let lx = 0; lx < g.keyW; lx += 1) {
            const c = ly * g.keyW + lx;
            const v = read(DAY, lx, ly);
            const where = `${at} ${lx},${ly}`;
            const cut = (lx === 0 || lx === g.keyW - 1) && (ly === sink || ly === g.keyH - 1);
            // Over its top, the bare ground; its own corners cut.
            if (ly < sink || cut) {
              expect(v, where).toBe(0);
              continue;
            }
            // It always draws inside its shape: its number muted, the rest unlit dusk — no cap,
            // no light band, no heat, no cobalt or deep, no cut-out; white only as today's cap.
            if (num[c] === 1) {
              expect(v, where).toBe(MUTED);
              muted += 1;
            } else if (today === DAY && ly - sink <= 1) expect(v, where).toBe(WHITE);
            else expect(v, where).toBe(DUSK);
          }
        }
        expect(muted, at).toBe(inkOf(num));
        // Not by hue alone: a SHAPE — its top a quarter lower than a standing key's, which is
        // lit (a slate cap, or today's white one) where the sunk key leaves the bare ground.
        expect(topRow(bare, g, DAY), at).toBe(0);
        expect(topRow(read, g, DAY), at).toBe(sink);
        expect(bare(DAY, 1, 0), at).toBe(today === DAY ? WHITE : RAIL);
        // …and never the ghost: a solid face, no slate checker.
        for (let ly = sink; ly < g.keyH; ly += 1) for (let lx = 0; lx < g.keyW; lx += 1) expect(read(DAY, lx, ly), at).not.toBe(RAIL);
      }
    }
  });

  it('sinks a row further, held down, like any key', () => {
    const model = overMonth();
    const tl = keysBeats({ ...SETTLED, model });
    const px = new Uint32Array(G.cols * G.rows);
    keysScene(G, model, tl, 1).draw(px, tl.settled + 100, false, DAY);
    const read = (i: number, lx: number, ly: number) => cell(px, i, lx, ly);
    // Its top row lost and the key a row lower: its top two rows under the sunk one's.
    expect(topRow(read, G, DAY)).toBe(sinkOf(H) + 2);
  });

  it('takes no link beside a finished neighbour', () => {
    const { tl, px } = frame(overMonth());
    expect(tl.links.some((l) => l.a === DAY || l.b === DAY)).toBe(false);
    // Nothing in the gap to its finished neighbour of the week.
    const { x, y } = keyAt(G, DAY);
    for (let r = 0; r < H; r += 1) for (let gx = 1; gx <= G.colGap; gx += 1) expect(px[(y + r) * G.cols + x + W - 1 + gx]).toBe(0);
  });

  it('comes in with the arrival and never charges', () => {
    const tl = keysBeats({ ...SETTLED, model: overMonth(), build: 'arrive' });
    expect(tl.keyIn[DAY]).toBeGreaterThan(-Infinity);
    expect(tl.charge[DAY]).toBe(-Infinity);
    expect(tl.lock[DAY]).toBe(-Infinity);
  });

  // A day turning over from `from` (a %, or a day never opened: a give-up at 0%), its frames
  // from the scene's start to its settling, one a FRAME — and each frame's key read back.
  const pressFrames = (g: CalGeometry, from: 'n' | `p${number}`, today = -1) => {
    const model = overMonth(today);
    const tl = keysBeats({ ...SETTLED, model, changes: [{ index: DAY, from }] });
    const scene = keysScene(g, model, tl, 1);
    const frames: ((i: number, lx: number, ly: number) => number)[] = [];
    for (let t = 0; t <= tl.settled + 32; t += 32) {
      const px = new Uint32Array(g.cols * g.rows);
      scene.draw(px, t, false, -1);
      frames.push((i, lx, ly) => {
        const { x, y } = keyAt(g, i);
        return px[(y + ly) * g.cols + x + lx];
      });
    }
    return { tl, frames };
  };
  const stateOf = (from: 'p40' | 'n') =>
    month((d) => (d === DAY ? (from === 'n' ? none(d) : { kind: 'progress', day: d, pct: 40 }) : d === DAY - 1 || d === DAY + 1 ? { kind: 'solved', day: d } : none(d)));

  it('turning over, is PRESSED — no charge, no burst, no dissolve of the whole picture', () => {
    for (const from of ['p40', 'n'] as const) {
      const tl = keysBeats({ ...SETTLED, model: overMonth(), changes: [{ index: DAY, from }] });
      expect(tl.press[DAY]).toBeGreaterThanOrEqual(0);
      expect(tl.dissolve[DAY]).toBe(-Infinity);
      expect(tl.charge[DAY]).toBe(-Infinity);
      expect(tl.bursts).toEqual([]);
    }
  });

  it('pressed, its top drops row by row to its sink, ONE number riding down with it, whole — then it rests sunk', () => {
    for (const g of SIZES) {
      for (const from of ['p40', 'n'] as const) {
        const { frames } = pressFrames(g, from);
        const sink = sinkOf(g.keyH);
        const was = frameAt(g, stateOf(from));
        const settled = frameAt(g, overMonth());
        const keyCells = (read: (i: number, lx: number, ly: number) => number) =>
          Array.from({ length: g.keyW * g.keyH }, (_, c) => read(DAY, c % g.keyW, Math.floor(c / g.keyW)));
        const standing = keyCells(was);
        const tops: number[] = [];
        frames.forEach((read, f) => {
          const at = `${g.name} from ${from}, frame ${f}`;
          const cells = keyCells(read);
          // Standing as it was: the picture before the press, whole.
          if (cells.every((v, c) => v === standing[c])) {
            expect(tops, `${at}: standing again after going down`).toEqual([]);
            return;
          }
          const top = topRow(read, g, DAY);
          tops.push(top);
          expect(top, at).toBeLessThanOrEqual(sink);
          // Exactly one number, whole: the over number's cells where its top stands it, every
          // one of them in the muted ink, its ring dusk — and no other number ink anywhere in
          // the key (white, or a digit cut out of a charge).
          const num = numberCells(g.keyW, g.keyH, DAY, top);
          let muted = 0;
          cells.forEach((v, c) => {
            const where = `${at} ${c % g.keyW},${Math.floor(c / g.keyW)}`;
            if (num[c] === 1) expect(v, where).toBe(MUTED);
            else if (num[c] === 2) expect(v, where).toBe(DUSK);
            expect([WHITE, GROUND], where).not.toContain(v);
            if (v === MUTED) muted += 1;
          });
          expect(muted, at).toBe(inkOf(num));
        });
        // Down a row at a time (two on WIDE's deeper sink), never back up, landing at its sink.
        expect(tops.length, g.name).toBeGreaterThanOrEqual(4);
        tops.forEach((top, k) => {
          if (k === 0) return;
          expect(top - tops[k - 1], `${g.name} step ${k}`).toBeGreaterThanOrEqual(0);
          expect(top - tops[k - 1], `${g.name} step ${k}`).toBeLessThanOrEqual(2);
        });
        expect(tops[tops.length - 1], g.name).toBe(sink);
        expect(keyCells(frames[frames.length - 1]), g.name).toEqual(keyCells(settled));
      }
    }
  });

  it('pressed, its light and its charge go out on the way down, cell by cell, never coming back', () => {
    for (const g of SIZES) {
      const { frames } = pressFrames(g, 'p40');
      const sink = sinkOf(g.keyH);
      const count = (read: (i: number, lx: number, ly: number) => number, ink: number) => {
        let n = 0;
        for (let ly = 0; ly < g.keyH; ly += 1) for (let lx = 0; lx < g.keyW; lx += 1) if (read(DAY, lx, ly) === ink) n += 1;
        return n;
      };
      // From the press's first frame (its number gone muted) to its landing: the slate light on
      // its top and the 40% charge at its foot only ever thin out…
      const pressing = frames.filter((read) => count(read, MUTED) > 0);
      for (const ink of [RAIL, heat(40)]) {
        const seen = pressing.map((read) => count(read, ink));
        seen.forEach((n, k) => k > 0 && expect(n, `${g.name} frame ${k}`).toBeLessThanOrEqual(seen[k - 1]));
        // …some of each still there on the way down, none once it has landed.
        expect(seen.some((n, k) => n > 0 && n < seen[0] && topRow(pressing[k], g, DAY) < sink), g.name).toBe(true);
        expect(seen[seen.length - 1], g.name).toBe(0);
      }
    }
  });

  it("pressed on today, keeps today's white cap on its top all the way down — at every size, from any %", () => {
    for (const g of SIZES) {
      for (const from of ['p40', 'p99'] as const) {
        const { frames } = pressFrames(g, from, DAY);
        for (const read of frames) {
          const top = topRow(read, g, DAY);
          for (let lx = 1; lx < g.keyW - 1; lx += 1) {
            expect(read(DAY, lx, top), `${g.name} from ${from}`).toBe(WHITE);
            expect(read(DAY, lx, top + 1), `${g.name} from ${from}`).toBe(WHITE);
          }
        }
      }
    }
  });

  it('restarted (a republish) charges up from the sunk key, RISING back to its height, lit', () => {
    // The second of two ups (the first has no frame before its charge): 10 newly played, 14 from over.
    const model = month((d) => (d === 10 ? { kind: 'progress', day: d, pct: 50 } : d === DAY ? { kind: 'progress', day: d, pct: 60 } : none(d)));
    const changes = [
      { index: 10, from: 'n' as const },
      { index: DAY, from: 'o' as const },
    ];
    const tl = keysBeats({ ...SETTLED, model, changes });
    expect(tl.charge[DAY]).toBeGreaterThan(0);
    expect(tl.dissolve[DAY]).toBe(-Infinity);
    const scene = keysScene(G, model, tl, 1);
    const px = new Uint32Array(G.cols * G.rows);
    const read = (i: number, lx: number, ly: number) => cell(px, i, lx, ly);
    const sink = sinkOf(H);
    // Before its charge: the sunk key, its number muted, unlit.
    scene.draw(px, tl.charge[DAY] / 2, false, -1);
    expect(topRow(read, G, DAY)).toBe(sink);
    const sunk = numberCells(W, H, DAY, sink);
    for (let ly = sink; ly < H; ly += 1) {
      for (let lx = 0; lx < W; lx += 1) {
        if ((lx === 0 || lx === W - 1) && (ly === sink || ly === H - 1)) continue;
        expect(cell(px, DAY, lx, ly), `${lx},${ly}`).toBe(sunk[ly * W + lx] === 1 ? MUTED : DUSK);
      }
    }
    // From the charge's first frame it is lit again (a slate cap on its top row), and it rises
    // as its front climbs: never lower than at the frame before.
    let last = sink;
    for (let t = tl.charge[DAY]; t < tl.charge[DAY] + 240; t += 32) {
      scene.draw(px, t, false, -1);
      const top = topRow(read, G, DAY);
      expect(top).toBeLessThanOrEqual(last);
      expect(cell(px, DAY, 2, top)).toBe(RAIL);
      last = top;
    }
    expect(last).toBeLessThan(sink);
    // Charged, it stands at its full height, its number white: nothing muted left.
    scene.draw(px, tl.settled + 100, false, -1);
    expect(topRow(read, G, DAY)).toBe(0);
    for (let ly = 0; ly < H; ly += 1) for (let lx = 0; lx < W; lx += 1) expect(cell(px, DAY, lx, ly)).not.toBe(MUTED);
  });
});

describe('a day restarted from over, rising', () => {
  // The second of two ups (the first has no frame before its charge), at a size: 10 newly
  // played, 14 back from over — today or not.
  const risingFrames = (g: CalGeometry, today: number) => {
    const model = month((d) => (d === 10 ? { kind: 'progress', day: d, pct: 50 } : d === 14 ? { kind: 'progress', day: d, pct: 60 } : none(d)), today);
    const tl = keysBeats({ ...SETTLED, model, changes: [{ index: 10, from: 'n' }, { index: 14, from: 'o' }] });
    const scene = keysScene(g, model, tl, 1);
    const frames: ((lx: number, ly: number) => number)[] = [];
    for (let t = tl.charge[14]; t < tl.charge[14] + tl.chargeMs; t += 32) {
      const px = new Uint32Array(g.cols * g.rows);
      scene.draw(px, t, false, -1);
      const { x, y } = keyAt(g, 14);
      frames.push((lx, ly) => px[(y + ly) * g.cols + x + lx]);
    }
    return frames;
  };

  it('keeps its number and its ring out of its cap rows on every frame, at every size, today too', () => {
    for (const g of SIZES) {
      const num = numberCells(g.keyW, g.keyH, 14);
      for (const today of [-1, 14]) {
        risingFrames(g, today).forEach((read, f) => {
          let top = g.keyH;
          for (let ly = 0; ly < g.keyH && top === g.keyH; ly += 1) for (let lx = 0; lx < g.keyW; lx += 1) if (read(lx, ly) !== 0) top = ly;
          for (const ly of [top, top + 1]) {
            for (let lx = 0; lx < g.keyW; lx += 1) {
              expect(num[ly * g.keyW + lx], `${g.name} today=${today} frame ${f} at ${lx},${ly}`).toBe(0);
            }
          }
        });
      }
    }
  });
});

describe('out of the window, and the pads', () => {
  it('draws a day out of range as its number alone, and a pad as nothing', () => {
    const model = month((d) => (d > 4 ? { kind: 'out', day: d } : none(d)));
    const { px } = frame(model);
    const m = digitMap(20);
    for (let ly = 0; ly < H; ly += 1) {
      for (let lx = 0; lx < W; lx += 1) {
        const v = cell(px, 20, lx, ly);
        expect(v).toBe(m[ly * W + lx] === 1 ? RAIL : 0);
      }
    }
    // Index 0 and 31… are pads: their boxes stay bare.
    for (const i of [0, 31, 41]) for (let ly = 0; ly < H; ly += 1) for (let lx = 0; lx < W; lx += 1) expect(cell(px, i, lx, ly)).toBe(0);
  });
});

describe('the runs', () => {
  it('links two finished days of one week, and stubs across a week only inside the month', () => {
    // Finished: 5, 6 (a week's last two), 7 (the next week's first), 9; 8 at 50%.
    const solved = new Set([5, 6, 7, 9]);
    const model = month((d) => (solved.has(d) ? { kind: 'solved', day: d } : d === 8 ? { kind: 'progress', day: d, pct: 50 } : none(d)));
    const { tl, px } = frame(model);
    expect(tl.links.map((l) => [l.a, l.b, l.wrap])).toEqual([
      [5, 6, false],
      [6, 7, true],
    ]);
    // The wrap's stubs: out of the 6th into the right bleed, into the 7th from the left one.
    const six = keyAt(G, 6);
    const seven = keyAt(G, 7);
    const m = Math.floor(H / 2);
    expect(px[(six.y + m - 1) * G.cols + six.x + W]).toBe(COBALT);
    expect(px[(seven.y + m - 1) * G.cols + seven.x - 1]).toBe(COBALT);
    // The month's last day finished and a pad after it: nothing leaves into the bleed.
    const last = month((d) => (d === 27 || d === 28 || d === 30 ? { kind: 'solved', day: d } : none(d)));
    expect(keysBeats({ ...SETTLED, model: last }).links.map((l) => [l.a, l.b, l.wrap])).toEqual([[27, 28, true]]);
  });
});

describe('today', () => {
  it('wears the white cap alone', () => {
    const { px } = frame(month(none, 4));
    for (let lx = 1; lx < W - 1; lx += 1) {
      expect(cell(px, 4, lx, 0)).toBe(WHITE);
      expect(cell(px, 4, lx, 1)).toBe(WHITE);
      expect(cell(px, 3, lx, 0)).toBe(RAIL);
    }
  });

  it('is the one foil, and only once it is finished', () => {
    const allSolved = month((d) => ({ kind: 'solved', day: d }), 4);
    const shiny = frame(allSolved);
    expect(shiny.scene.foilBoxes).toEqual([{ ...keyAt(G, 4), w: W, h: H + 1 }]);
    expect(shiny.scene.loop).toBe('foil');
    // Its body is no longer the plain cobalt; its neighbours are.
    let foiled = 0;
    for (let lx = 1; lx < W - 1; lx += 1) if (cell(shiny.px, 4, lx, 4) !== COBALT) foiled += 1;
    expect(foiled).toBeGreaterThan(W / 2);
    for (let lx = 1; lx < W - 1; lx += 1) expect(cell(shiny.px, 3, lx, 4)).toBe(COBALT);
    // …its number still cut out of it.
    const m = digitMap(4);
    for (let k = 0; k < m.length; k += 1) if (m[k] === 1) expect(cell(shiny.px, 4, k % W, Math.floor(k / W))).toBe(GROUND);

    const notToday = frame(month((d) => ({ kind: 'solved', day: d }), -1));
    expect(notToday.scene.foilBoxes).toEqual([]);
    expect(notToday.scene.loop).toBe(null);
    const unfinished = frame(month((d) => (d === 4 ? { kind: 'progress', day: d, pct: 80 } : { kind: 'solved', day: d }), 4));
    expect(unfinished.scene.foilBoxes).toEqual([]);
  });

  it('falls once in the arrival: held back as bare ground, falling as itself, then it lands', () => {
    const model = month(none, 11);
    const tl = keysBeats({ ...SETTLED, model, build: 'arrive', drop: 'build' });
    expect(tl.drop).not.toBeNull();
    // Whatever stood in its place before (a loading ghost) is gone while it is held back.
    const before = new Uint32Array(G.cols * G.rows).fill(RAIL);
    const scene = keysScene(G, model, tl, 1, before);
    const px = new Uint32Array(G.cols * G.rows);
    scene.draw(px, tl.drop! - 40, false, -1);
    for (let ly = 0; ly < H; ly += 1) for (let lx = 0; lx < W; lx += 1) expect(cell(px, 11, lx, ly)).toBe(0);
    // Falling: the key itself — its white cap somewhere in the headroom above its place, its
    // iron under it, never a white block — and its place's foot still bare.
    scene.draw(px, tl.drop! + 40, false, -1);
    const { x, y } = keyAt(G, 11);
    const at = (Y: number, lx: number) => px[Y * G.cols + x + lx];
    const capped = (Y: number) => Array.from({ length: W - 2 }, (_, k) => at(Y, k + 1)).every((v) => v === WHITE);
    const cap = Array.from({ length: HEADROOM }, (_, k) => y - HEADROOM + k).filter(capped);
    expect(cap.length).toBeGreaterThan(0);
    expect(at(cap[cap.length - 1] + 3, 5)).toBe(DUSK);
    for (let lx = 0; lx < W; lx += 1) expect(cell(px, 11, lx, H - 1)).toBe(0);
    scene.draw(px, tl.impact! + 200, false, -1);
    expect(cell(px, 11, 5, 5)).toBe(DUSK);
  });

  it('lands as loud as it is full: no burst and no white for a day never opened, or over', () => {
    const land = (state: KeyState) => keysBeats({ ...SETTLED, model: month((d) => (d === 4 ? state : none(d)), 4), drop: 'build' });
    for (const state of [none(4), { kind: 'over', day: 4 }] as const) {
      const quiet = land(state);
      expect(quiet.bursts).toEqual([]);
      expect(quiet.impactFlash).toBe(false);
      // Never the foil: that is a finished today's alone.
      expect(quiet.foil).toBeUndefined();
      expect(keysScene(G, month((d) => (d === 4 ? state : none(d)), 4), quiet, 1).foilBoxes).toEqual([]);
    }
    for (const state of [{ kind: 'progress', day: 4, pct: 40 }, { kind: 'solved', day: 4 }] as const) {
      const loud = land(state);
      expect(loud.bursts).toEqual([{ index: 4, at: loud.impact }]);
      expect(loud.impactFlash).toBe(true);
    }
  });
});

describe('the beats', () => {
  it('spends no white on the arrival but the write heads: caps lock and links join in cobalt', () => {
    const model = month((d) => (d <= 12 ? { kind: 'solved', day: d } : none(d)));
    const tl = keysBeats({ ...SETTLED, model, build: 'arrive' });
    expect(tl.flash.some(Boolean)).toBe(false);
    expect(tl.links.length).toBeGreaterThan(0);
    expect(tl.links.some((l) => l.flash)).toBe(false);
  });

  it("lets a new solve's ceremony flash: its cap and its links white", () => {
    const model = month((d) => ({ kind: 'solved', day: d }));
    const tl = keysBeats({ ...SETTLED, model, changes: [{ index: 10, from: 'n' }] });
    expect(tl.flash[10]).toBe(true);
    expect(tl.links.filter((l) => l.flash).map((l) => [l.a, l.b])).toEqual([
      [9, 10],
      [10, 11],
    ]);
  });

  it('settles only once every burst has blown out', () => {
    const specs: Partial<KeysSpec>[] = [
      { build: 'arrive', drop: 'build' },
      { drop: 'flip' },
      { changes: [{ index: 10, from: 'n' }, { index: 11, from: 'p40' }] },
    ];
    for (const spec of specs) {
      const tl = keysBeats({ ...SETTLED, ...spec, model: month((d) => ({ kind: 'solved', day: d }), 4) });
      expect(tl.bursts.length).toBeGreaterThan(0);
      for (const burst of tl.bursts) expect(tl.settled).toBeGreaterThanOrEqual(burst.at + BURST_ART.ms);
    }
  });

  it('lets no ghost rise in a scene replaced before it began', () => {
    const model = month((d) => ({ kind: 'unknown', day: d }), -1, 'loading');
    const tl = keysBeats({ ...SETTLED, model, digitsIn: true, ghostsIn: true });
    const scene = keysScene(G, model, tl, 1);
    const px = new Uint32Array(G.cols * G.rows);
    // Replaced at 100ms (its read landed): at 900ms, the numbers stand and no ghost cell does.
    scene.draw(px, 900, false, -1, 100);
    const m = digitMap(8);
    let checker = 0;
    for (let ly = 0; ly < H; ly += 1) {
      for (let lx = 0; lx < W; lx += 1) if (m[ly * W + lx] === 0 && cell(px, 8, lx, ly) !== 0) checker += 1;
    }
    expect(checker).toBe(0);
    // Not replaced, it would stand by then.
    scene.draw(px, 900, false, -1);
    let standing = 0;
    for (let ly = 0; ly < H; ly += 1) {
      for (let lx = 0; lx < W; lx += 1) if (m[ly * W + lx] === 0 && cell(px, 8, lx, ly) !== 0) standing += 1;
    }
    expect(standing).toBeGreaterThan(0);
  });
});
