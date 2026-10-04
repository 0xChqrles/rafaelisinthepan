import { describe, expect, it } from 'vitest';
import { COUNT_EM, COUNT_ROWS, DIGIT_MASKS, countInk, inkEms, progressHeatColor } from '@whippin/shared';
import { abgr, hexToAbgr } from '../raster';
import { BLEED, calGeometry, type CalGeometry } from './geometry';
import { keysBeats, keysScene, type KeyState, type KeysModel, type KeysSpec } from './keysScene';

// The month's keys carry the archive's promises (contract.md K9, K16; the direction's own):
// a day under 100 is never drawn finished — its cap and light band stay iron, it never takes a
// run's link — while 1% still shows ink; a finished day is charged through and through; a
// number never breaks into dither; a day not known yet is never drawn as one not started; a day
// out of the window is a number and no key; runs join only finished days of one week, across a
// week's end only inside the month; and the one shiny thing is today's, only once it is done.

const WHITE = hexToAbgr('#ffffff');
const MUTED = hexToAbgr('#a6adb8');
const RAIL = hexToAbgr('#4a5578');
const COBALT = hexToAbgr('#4a6aff');
const DEEP = hexToAbgr('#1c2566');
const GROUND = hexToAbgr('#050507');
const DUSK = hexToAbgr('#1f212a');
const heat = (pct: number) => {
  const [r, g, b] = progressHeatColor(pct).match(/\d+/g)!.map(Number);
  return abgr(r, g, b);
};

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
const keyAt = (i: number) => ({ x: BLEED + (i % 7) * (W + G.colGap), y: BLEED + Math.floor(i / 7) * (H + G.rowGap) });
const cell = (px: Uint32Array, i: number, lx: number, ly: number) => {
  const { x, y } = keyAt(i);
  return px[(y + ly) * G.cols + x + lx];
};
const corner = (lx: number, ly: number) => (lx === 0 || lx === W - 1) && (ly === 0 || ly === H - 1);
// The number's cells (1) and its ring (2), where the scene stands them.
function digitMap(day: number): Uint8Array {
  const m = new Uint8Array(W * H);
  const text = String(day);
  const x0 = Math.floor((W - Math.round(inkEms(text.length) * COUNT_EM)) / 2);
  const y0 = 1 + Math.floor((H - 1 - COUNT_ROWS) / 2);
  const on = countInk(DIGIT_MASKS, text);
  for (let gy = 0; gy < COUNT_ROWS; gy += 1) {
    for (let gx = 0; gx < text.length * COUNT_EM; gx += 1) if (on(gx, gy)) m[(y0 + gy) * W + x0 + gx] = 1;
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (m[y * W + x] !== 1) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const k = (y + dy) * W + x + dx;
          if (x + dx >= 0 && x + dx < W && y + dy >= 0 && y + dy < H && m[k] === 0) m[k] = 2;
        }
      }
    }
  }
  return m;
}
const none = (day: number): KeyState => ({ kind: 'none', day });

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
      const { x, y } = keyAt(10);
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

describe('a finished day is charged through', () => {
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
    const six = keyAt(6);
    const seven = keyAt(7);
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
    expect(shiny.scene.foilBoxes).toEqual([{ ...keyAt(4), w: W, h: H + 1 }]);
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

  it('drops once in the arrival: held back, then the silhouette, then it lands', () => {
    const model = month(none, 4);
    const tl = keysBeats({ ...SETTLED, model, build: 'arrive', drop: 'build' });
    expect(tl.drop).not.toBeNull();
    expect(tl.bursts.map((b) => b.index)).toEqual([4]);
    const scene = keysScene(G, model, tl, 1);
    const px = new Uint32Array(G.cols * G.rows);
    scene.draw(px, tl.drop! - 40, false, -1);
    expect(cell(px, 4, 5, 10)).toBe(0);
    scene.draw(px, tl.impact! + 200, false, -1);
    expect(cell(px, 4, 5, 10)).toBe(DUSK);
  });
});
