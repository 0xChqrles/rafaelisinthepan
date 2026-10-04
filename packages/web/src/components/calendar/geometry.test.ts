import { describe, expect, it } from 'vitest';
import { BLEED, CELL_PX, FOOT_PX, HEADROOM, STACK_TOP_PX, calGeometry, stackedHeightPx } from './geometry';

// The calendar's raster stands on WHOLE PIXELS only if every size it is laid out with is a whole
// number of 2px cells; and the month must fit the room it is given — a desktop window never
// scrolls, so a month that would run under its foot goes sideways instead.

// A window: its width, its height, and the column `.app` leaves the archive (the board's 560 at
// most, less `.app`'s padding: 14px a side on a phone, 52px on a desktop).
const room = (w: number, h: number) => {
  const phone = w <= 640;
  const column = Math.min(560, w - (phone ? 28 : 104));
  return { column, h, phone, G: calGeometry(column, h, phone) };
};

describe('calGeometry — the first candidate that fits', () => {
  it('picks the regular keys on a 390 phone, the narrow ones at 320', () => {
    expect(room(390, 844).G.name).toBe('regular');
    expect(room(320, 568).G.name).toBe('narrow');
    expect(room(360, 800).G.name).toBe('compact');
    expect(room(412, 915).G.name).toBe('regular');
    expect(room(280, 653).G.name).toBe('tiny');
  });

  it('stands the wide month on a desktop, and the mid one in a short window', () => {
    const wide = room(1366, 800).G;
    expect(wide.name).toBe('wide');
    expect(wide.layout).toBe('stacked');
    expect(room(1366, 657).G.name).toBe('mid');
  });

  it('stands the phone keys stacked in a desktop window too short for MID, before going sideways', () => {
    const regular = room(1280, 610).G;
    expect(regular.name).toBe('regular');
    expect(regular.layout).toBe('stacked');
    expect(room(1280, 560).G.name).toBe('compact');
    expect(room(740, 360).G.name).toBe('sideways');
    expect(room(844, 390).G.name).toBe('sideways');
    expect(room(1366, 657).G.name).toBe('mid');
    expect(room(1366, 800).G.name).toBe('wide');
  });

  it('lays a landscape phone sideways', () => {
    const G = room(740, 360).G;
    expect(G.name).toBe('sideways');
    expect(G.layout).toBe('sideways');
    expect([G.keyWPx, G.keyHPx]).toEqual([44, 32]);
  });

  it('keeps every pixel size even, so every cell is whole', () => {
    for (const [w, h] of [
      [280, 653],
      [320, 568],
      [360, 800],
      [390, 844],
      [412, 915],
      [740, 360],
      [1366, 657],
      [1366, 800],
    ]) {
      const { G } = room(w, h);
      for (const px of [G.keyWPx, G.keyHPx, G.colGapPx, G.rowGapPx, G.gridW, G.gridH, G.airPx]) {
        expect(px % 2).toBe(0);
      }
      expect(G.keyWPx).toBe(G.keyW * CELL_PX);
      expect(G.gridW).toBe(7 * G.keyWPx + 6 * G.colGapPx);
      expect(G.gridH).toBe(6 * G.keyHPx + 5 * G.rowGapPx);
      expect(G.cols).toBe(G.gridW / CELL_PX + 2 * BLEED);
      expect(G.rows).toBe(HEADROOM + G.gridH / CELL_PX + BLEED);
    }
  });

  it('fits the grid in its column, on a whole pixel', () => {
    for (const [w, h] of [
      [320, 568],
      [390, 844],
      [1366, 800],
      [1366, 657],
    ]) {
      const { G, column } = room(w, h);
      expect(G.gridX + G.gridW).toBeLessThanOrEqual(column);
      expect(Number.isInteger(G.gridX)).toBe(true);
    }
    // …down to a fold's cover screen: no phone under 320 scrolls sideways.
    for (let w = 278; w <= 640; w += 1) {
      const { G, column } = room(w, 700);
      expect(G.gridX + G.gridW).toBeLessThanOrEqual(column);
    }
  });

  it('ends a stacked desktop month above the window foot, else goes sideways', () => {
    for (let h = 300; h <= 1000; h += 7) {
      const { G } = room(1366, h);
      if (G.layout === 'stacked') expect(STACK_TOP_PX + stackedHeightPx(G)).toBeLessThanOrEqual(h - FOOT_PX);
    }
  });
});
