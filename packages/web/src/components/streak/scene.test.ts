import { describe, expect, it } from 'vitest';
import { timeline } from './beats';
import { COBALT, DUSK, FOIL, FOIL_DEEP, GROUND, RAIL, WHITE, linkCellsAt } from './sprites';
import { RESERVE_BITS, layout, numberPlace, type NumberCells } from './geometry';
import { orbitScene, type OrbitDay } from './scene';

// A block "count" stands in for the pixel face's glyphs (the dialog reads those off
// `assets/digits.png`): `w` glyph pixels wide, seven tall, every one inked.
const block = (w: number): NumberCells => ({ w, h: 7, bits: new Uint8Array(w * 7).fill(1) });

const SIZES = [
  [320, 568],
  [375, 667],
  [390, 844],
  [844, 390],
  [1280, 800],
  // Short landscape: the stack's height binds.
  [568, 320],
  [740, 360],
  [1280, 600],
] as const;

// The scene for a week written S solved, T today, F to come, M missed (Monday first).
function sceneFor(week: string, opts: { width?: number; height?: number; weeks?: number; carriesIn?: boolean } = {}) {
  const from = block(7);
  const to = block(14);
  const L = layout(opts.width ?? 390, opts.height ?? 844, RESERVE_BITS, to.w);
  const days: OrbitDay[] = Array.from(week, (c) => ({ solved: c === 'S', today: c === 'T', future: c === 'F' }));
  const todayIndex = week.indexOf('T');
  const hasComet = todayIndex > 0 && week[todayIndex - 1] === 'S';
  const closes = week === 'SSSSSST';
  const tl = timeline(hasComet, closes, todayIndex);
  const scene = orbitScene({ L, days, from, to, weeks: opts.weeks ?? 0, carriesIn: opts.carriesIn ?? false, closes, clear: [], tl });
  const frame = (t: number) => {
    const ink = new Uint8Array(L.cols * L.rows);
    scene.draw(ink, t);
    return ink;
  };
  // The inks a link's metal wears at `t` (the set over its non-hole cells).
  const linkInks = (ink: Uint8Array, day: number) =>
    new Set(
      linkCellsAt(L.links[day])
        .filter((c) => c.part === 'metal')
        .map((c) => ink[c.y * L.cols + c.x]),
    );
  return { L, tl, to, frame, linkInks };
}

// Every frame of the show, and some seconds of rest, a show frame apart.
const showTimes = (tl: { settled: number }, rest = 9000) =>
  Array.from({ length: Math.ceil((tl.settled + rest) / 50) }, (_, i) => i * 50);

describe('the streak orbit scene', () => {
  it('draws the same cells for the same moment, on every call', () => {
    const { tl, frame } = sceneFor('SSSSTFF', { weeks: 2 });
    for (const t of [0, tl.prevIn + 100, tl.impact + 50, tl.impact + 300, tl.light + 40, tl.flare, tl.settled + 2500]) {
      expect(frame(t)).toEqual(frame(t));
    }
  });

  it('holds the whole new count in white once settled, the landing chip gone', () => {
    const { L, tl, to, frame } = sceneFor('SSSSTFF');
    const ink = frame(tl.settled + 400);
    const at = numberPlace(L, to);
    for (let y = 0; y < to.h * L.k; y += 1)
      for (let x = 0; x < to.w * L.k; x += 1) expect(ink[(at.y + y) * L.cols + at.x + x]).toBe(WHITE);
    // Nothing of the chip is left around it: the rows above and below the count are bare.
    for (let x = 0; x < to.w * L.k; x += 1) {
      expect(ink[(at.y - 1) * L.cols + at.x + x]).not.toBe(WHITE);
      expect(ink[(at.y + to.h * L.k) * L.cols + at.x + x]).not.toBe(GROUND);
    }
  });

  it('closes the week’s orbit through the crown only on a full week', () => {
    const top = (week: string) => {
      const { L, tl, frame } = sceneFor(week);
      const ink = frame(tl.settled + 400);
      // The orbit's upper arc either side of the flame, clear of its light.
      const { cy, rx, ry } = L.ring;
      return [-0.75, -0.55, 0.55, 0.75].some((u) => {
        const x = L.cx + u * rx;
        const y = cy - ry * Math.sqrt(1 - u * u);
        for (let dy = -1; dy <= 1; dy += 1) if (ink[Math.floor(y + dy) * L.cols + Math.floor(x)] === COBALT) return true;
        return false;
      });
    };
    expect(top('SSSSSST')).toBe(true);
    expect(top('SSSSSTF')).toBe(false);
  });

  it('forges today’s link: a ghost before the pour, molten before the strike, foil once cooled', () => {
    const { tl, frame, linkInks } = sceneFor('SSSSTFF');
    const before = linkInks(frame(tl.pour - 20), 4);
    expect(before.has(COBALT) || before.has(WHITE)).toBe(false);
    expect(before.has(RAIL)).toBe(true);
    expect(linkInks(frame(tl.light - 40), 4).has(COBALT)).toBe(true);
    expect([...linkInks(frame(tl.light + 30), 4)]).toEqual([WHITE]);
    expect([...linkInks(frame(tl.settled + 400), 4)]).toEqual([FOIL]);
  });

  it('lights the earlier links from iron to cobalt nearest first, once today is struck', () => {
    const { tl, frame, linkInks } = sceneFor('SSSSTFF');
    // Iron until the strike.
    const struck = frame(tl.light + 30);
    for (let d = 0; d < 4; d += 1) expect([...linkInks(struck, d)]).toEqual([RAIL]);
    // The moment each one turns: the nearest first.
    const litBy = (d: number) => {
      for (let t = tl.light; t < tl.settled; t += 10) if (linkInks(frame(t), d).has(COBALT)) return t;
      return Infinity;
    };
    const order = [3, 2, 1, 0].map(litBy);
    expect(order.every(Number.isFinite)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(4);
    // Settled: the chain cobalt, the days to come still ghosts, only today foil.
    const rest = frame(tl.settled + 400);
    for (let d = 0; d < 4; d += 1) expect([...linkInks(rest, d)]).toEqual([COBALT]);
    for (const d of [5, 6]) expect(linkInks(rest, d).has(COBALT) || linkInks(rest, d).has(FOIL)).toBe(false);
  });

  it('turns the whole chain to foil on a full week, and only then', () => {
    const week = sceneFor('SSSSSST');
    const ink = week.frame(week.tl.settled + 400);
    for (let d = 0; d < 7; d += 1) expect([...week.linkInks(ink, d)]).toEqual([FOIL]);
    const deep = linkCellsAt(week.L.links[2]).filter((c) => c.part === 'deep');
    for (const c of deep) expect(ink[c.y * week.L.cols + c.x]).toBe(FOIL_DEEP);
    const run = sceneFor('SSSSSTF');
    const ink2 = run.frame(run.tl.settled + 400);
    for (let d = 0; d < 5; d += 1) expect(run.linkInks(ink2, d).has(FOIL)).toBe(false);
  });
});

describe('the chain’s links', () => {
  it('leaves a missed day’s link open in iron, and a day to come an empty ghost — corners kept', () => {
    const { L, tl, frame } = sceneFor('MMSTFFF');
    const ink = frame(tl.settled + 400);
    const at = (c: { x: number; y: number }) => ink[c.y * L.cols + c.x];
    for (const d of [0, 1]) {
      const cells = linkCellsAt(L.links[d]).filter((c) => c.part !== 'hole');
      for (const c of cells) expect(at(c)).toBe(c.cut ? 0 : c.part === 'deep' ? DUSK : RAIL);
      expect(cells.some((c) => c.cut)).toBe(true);
    }
    for (const d of [4, 5, 6]) {
      const cells = linkCellsAt(L.links[d]).filter((c) => c.part !== 'hole');
      for (const c of cells) expect(at(c)).toBe(c.ghost ? RAIL : 0);
      // The ghost keeps the link's four rounded corners whole.
      for (const [lx, ly] of [
        [1, 1],
        [2, 1],
        [1, 2],
        [9, 6],
      ])
        expect(cells.find((c) => c.lx === lx && c.ly === ly)?.ghost).toBe(true);
    }
  });

  it('never flashes an edge-on link white inside a hole', () => {
    for (const week of ['SSSSTFF', 'SSSSSST']) {
      const { L, tl, frame } = sceneFor(week);
      const holes = L.links.flatMap((l) => linkCellsAt(l).filter((c) => c.part === 'hole'));
      for (let t = tl.light - 400; t < tl.settled; t += 20) {
        const ink = frame(t);
        for (const c of holes) expect(ink[c.y * L.cols + c.x], `${week} t=${t} ${c.x},${c.y}`).not.toBe(WHITE);
      }
    }
  });

  it('holds no lone pixel of glitter in the air round the chain, ever', () => {
    for (const week of ['SSSSTFF', 'SSSSSST', 'MMMMTFF']) {
      const { L, tl, frame } = sceneFor(week);
      const covered = new Set(L.links.flatMap((l) => linkCellsAt(l).map((c) => c.y * L.cols + c.x)));
      const top = Math.min(...L.links.map((l) => l.y)) - 16;
      const bottom = Math.max(...L.links.map((l) => l.y)) + 16;
      for (const t of showTimes(tl).filter((v) => v >= tl.settled)) {
        const ink = frame(t);
        for (let y = top; y <= bottom; y += 1) {
          for (let x = 1; x < L.cols - 1; x += 1) {
            const i = y * L.cols + x;
            if (ink[i] !== WHITE || covered.has(i)) continue;
            const neighbours = [i - 1, i + 1, i - L.cols, i + L.cols].filter((j) => ink[j] !== 0).length;
            expect(neighbours, `a lone white cell at ${x},${y}, t=${t}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('the frame', () => {
  it('keeps every orbit, ring and shock out of the lockup’s top band, on every screen', () => {
    for (const [w, h] of SIZES) {
      const { L, tl, frame } = sceneFor('SSSSTFF', { width: w, height: h, weeks: 14, carriesIn: true });
      const band = Math.floor(L.topBand / L.cell) - 1;
      // The crown's flame may lick up into the band's height (a phone on its side): it is
      // the subject, centred between the lockup and the edition.
      const flame = (x: number) => Math.abs(x + 0.5 - L.crown.x) <= L.crown.w * 2.5;
      for (const t of showTimes(tl).filter((_, i) => i % 6 === 0)) {
        const ink = frame(t);
        for (let i = 0; i < band * L.cols; i += 1)
          if (!flame(i % L.cols)) expect(ink[i], `${w}×${h} t=${t} at ${i % L.cols}`).toBe(0);
      }
    }
  });
});
