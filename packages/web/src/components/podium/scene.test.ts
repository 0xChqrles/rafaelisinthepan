import { describe, expect, it } from 'vitest';
import { LINE_PX } from '../boardMetrics';
import { CELL_PX, beats, layout, podiumHeightPx, podiumSize, type BeatSpec } from './scene';

// The podium's box and beats carry the board screen's promises: the box is whole lines (so the
// column under it rests on whole lines and your held line covers exactly one), the size never
// leaves the lines no room, the three captions never run into each other, the winner's number
// is never the smallest — and stands at its full size whatever the board counts — a board turned
// back to never replays its build, and a turn never leaves the list bare.

describe('podiumHeightPx — the box is whole lines', () => {
  it('is a whole number of the lines\' pitch in both sizes', () => {
    for (const size of ['roomy', 'compact'] as const) {
      expect(podiumHeightPx(size) % LINE_PX).toBe(0);
    }
    expect(podiumHeightPx('compact')).toBeLessThan(podiumHeightPx('roomy'));
  });
});

describe('podiumSize — chosen off the room, never taller than it leaves lines for', () => {
  const slots = (size: 'roomy' | 'compact') => podiumHeightPx(size) / LINE_PX;

  it('stands roomy where it leaves the header and four lines, and its steps fit across', () => {
    expect(podiumSize(362, slots('roomy') + 1 + 4, null)).toBe('roomy');
  });

  it('steps down to compact on a short column, or a narrow one', () => {
    expect(podiumSize(362, slots('roomy') + 1 + 3, null)).toBe('compact');
    expect(podiumSize(300, 20, null)).toBe('compact');
  });

  it('stands none where even the compact one would leave fewer than two lines', () => {
    expect(podiumSize(560, slots('compact') + 1 + 1, null)).toBeNull();
    expect(podiumSize(560, 4, null)).toBeNull();
  });

  it('keeps the size it has for one line of grace (a toolbar never flips it)', () => {
    expect(podiumSize(362, slots('roomy') + 1 + 3, 'roomy')).toBe('roomy');
    expect(podiumSize(362, slots('roomy') + 1 + 2, 'roomy')).toBe('compact');
    expect(podiumSize(560, slots('compact') + 1 + 1, 'compact')).toBe('compact');
  });
});

describe('layout — where the three stand', () => {
  const widths = [252, 292, 316, 347, 362, 532];

  it('keeps every caption inside the column, the three apart', () => {
    for (const w of widths) {
      for (const size of ['roomy', 'compact'] as const) {
        const L = layout(w, size, [1, 2, 3], [8, 14, 34]);
        const [first, second, third] = L.places;
        for (const place of L.places) {
          expect(place.slot.x).toBeGreaterThanOrEqual(0);
          expect(place.slot.x + place.slot.w).toBeLessThanOrEqual(L.cols);
          expect(place.step.x).toBeGreaterThanOrEqual(0);
          expect(place.step.x + place.step.w).toBeLessThanOrEqual(L.cols);
        }
        expect(second.slot.x + second.slot.w).toBeLessThan(first.slot.x);
        expect(first.slot.x + first.slot.w).toBeLessThan(third.slot.x);
      }
    }
  });

  it('never draws the winner\'s number smaller than the others\', three digits on the compact podium included', () => {
    for (const size of ['roomy', 'compact'] as const) {
      const L = layout(347, size, [1, 2, 3], [187, 190, 204]);
      expect(L.places[0].vpx).toBeGreaterThan(L.places[1].vpx);
      expect(L.places[0].value.w).toBeLessThanOrEqual(L.cols);
    }
  });

  it('keeps a first\'s value clear of its neighbours\' numbers', () => {
    const L = layout(347, 'compact', [1, 2, 3], [187, 190, 204]);
    const [first, second, third] = L.places;
    expect(second.value.x + second.value.w).toBeLessThan(first.value.x);
    expect(first.value.x + first.value.w).toBeLessThan(third.value.x);
  });

  it('sets the floor, the names and every caption\'s block inside the box', () => {
    for (const size of ['roomy', 'compact'] as const) {
      const L = layout(362, size, [1, 2, 3], [8, 14, 34]);
      expect(L.rows * CELL_PX).toBe(podiumHeightPx(size));
      expect(L.name).toBeGreaterThan(L.floor);
      // The unit's line (6 rows) ends inside the box.
      for (const place of L.places) expect(place.unit + 6).toBeLessThanOrEqual(L.rows);
    }
  });

  it('draws a period\'s first as large as a day\'s: its points carry nothing under their unit', () => {
    for (const size of ['roomy', 'compact'] as const) {
      // A week's 9 / 6 / 3 points, and a day's 9 tries over 14 and 34: one size for the 9.
      const week = layout(362, size, [1, 2, 3], [9, 6, 3]);
      const day = layout(362, size, [1, 2, 3], [9, 14, 34]);
      expect(week.places[0].vpx).toBe(day.places[0].vpx);
      expect(week.places[0].vpx).toBeGreaterThan(week.places[1].vpx);
    }
    expect(layout(347, 'compact', [1, 2, 3], [9, 6, 3]).places[0].vpx).toBeGreaterThan(1);
  });

  it('stands two tied firsts equally tall, each number inside its own slot', () => {
    const L = layout(362, 'roomy', [1, 1, 3], [12, 12, 17]);
    expect(L.places[0].step.h).toBe(L.places[1].step.h);
    for (const place of L.places.slice(0, 2)) {
      expect(place.value.x).toBeGreaterThan(place.slot.x);
      expect(place.value.x + place.value.w).toBeLessThan(place.slot.x + place.slot.w);
    }
  });
});

describe('beats — a build, a turn, a board shown again', () => {
  const spec = (over: Partial<BeatSpec>): BeatSpec => ({
    steps: true,
    loading: false,
    build: true,
    standing: false,
    present: [true, true, true],
    firsts: [true, false, false],
    stood: [false, false, false],
    reels: [true, true, true],
    startMs: 260,
    runMs: 650,
    ...over,
  });

  it('on an arrival, raises the steps and starts the lines once the last landing has shaken', () => {
    const tl = beats(spec({}));
    expect(tl.rise.every((at) => at !== null && at >= 260)).toBe(true);
    const lastLanding = Math.max(...tl.land.map((at) => at ?? 0));
    expect(tl.lines).toBeGreaterThan(lastLanding);
    expect(tl.foil[0]).not.toBeNull();
    expect(tl.settled).toBeGreaterThan(tl.foil[0]!);
  });

  it('on a turn (steps standing), raises nothing and starts the lines at once', () => {
    const tl = beats(spec({ standing: true, startMs: 0 }));
    expect(tl.rise.every((at) => at !== null && at < 0)).toBe(true);
    expect(tl.lines).toBe(0);
    expect(tl.fall).toEqual([true, true, true]);
  });

  it('keeps a player who stood on the same place standing', () => {
    const tl = beats(spec({ standing: true, startMs: 0, stood: [true, false, false], reels: [false, true, true] }));
    expect(tl.fall[0]).toBe(false);
    expect(tl.reel[0]).toBeNull();
  });

  it('draws a board shown before settled: nobody drops, no number runs, the lines at once', () => {
    const tl = beats(spec({ build: false, standing: true, startMs: 0 }));
    expect(tl.fall).toEqual([false, false, false]);
    expect(tl.reel).toEqual([null, null, null]);
    expect(tl.lines).toBe(0);
  });

  it('settles the whole arrival within about two seconds', () => {
    expect(beats(spec({})).settled).toBeLessThanOrEqual(2400);
  });
});
