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
import { keysBeats, keysScene, numberCells, type KeyState, type KeysModel, type KeysSpec } from './keysScene';

// The month's keys carry the archive's promises (contract.md K9, K16; the direction's own):
// a day under 100 is never drawn finished — its cap and light band stay iron, it never takes a
// run's link — while 1% still shows ink; a finished day is charged through and through, lit on
// top and dark at its foot, the other way up from a high %; a number never breaks into dither
// or slivers; a day not known yet is never drawn as one not started; a day out of the window is
// a number and no key; runs join only finished days of one week, across a week's end only
// inside the month; and the one shiny thing is today's, only once it is done.

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

describe("a number's edge is the ink's", () => {
  it('stands an ink ring only on a row a third inked or more, a dusk ring only on one at most two thirds', () => {
    expect(new Set(SIZES.map((g) => g.name)).size).toBe(7);
    for (const g of SIZES) {
      const corners = (lx: number, ly: number) => (lx === 0 || lx === g.keyW - 1) && (ly === 0 || ly === g.keyH - 1);
      for (let pct = 1; pct <= 99; pct += 1) {
        const read = frameAt(g, month((d) => (d === 7 || d === 23 ? { kind: 'progress', day: d, pct } : none(d))));
        for (const day of [7, 23]) {
          const m = numberCells(g.keyW, g.keyH, day);
          for (let ly = 0; ly < g.keyH; ly += 1) {
            // The row's face: its cells in the key's shape, outside the number and its ring.
            let face = 0;
            let inked = 0;
            const ring: number[] = [];
            for (let lx = 0; lx < g.keyW; lx += 1) {
              const v = read(day, lx, ly);
              if (m[ly * g.keyW + lx] === 2) ring.push(v);
              else if (m[ly * g.keyW + lx] === 0 && !corners(lx, ly)) {
                face += 1;
                if (v === heat(pct)) inked += 1;
              }
            }
            if (face < 4) continue;
            const at = `${g.name} ${pct}% day ${day} row ${ly}`;
            for (const v of ring) {
              if (v === heat(pct)) expect(inked / face, at).toBeGreaterThanOrEqual(1 / 3);
              if (v === DUSK) expect(inked / face, at).toBeLessThanOrEqual(2 / 3);
            }
          }
        }
      }
    }
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

  it('lands as loud as it is full: no burst and no white for a day never opened', () => {
    const land = (state: KeyState) => keysBeats({ ...SETTLED, model: month((d) => (d === 4 ? state : none(d)), 4), drop: 'build' });
    const quiet = land(none(4));
    expect(quiet.bursts).toEqual([]);
    expect(quiet.impactFlash).toBe(false);
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
