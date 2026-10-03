// The foil (`foil.ts`): a function of (surface, time, seed) the screen paints every frame and
// the share card draws once on the server — it must yield an ink for every cell it is asked.
import { describe, expect, it } from 'vitest';
import { FOIL_WHITE, HOLO_INKS, foilCells, foilInkRgb } from './foil';

describe('foilCells — every cell an ink of the loop', () => {
  it('never steps past the loop where a place falls a hair under a whole turn', () => {
    // 24×16 at 7.25 s, seed 2.5: one cell's place on the loop is −5.6e-17, whose fractional
    // part rounds to exactly 1 — one ink past the loop's end.
    const inks: number[] = [];
    foilCells(24, 16, 7.25, 2.5, null, null, 2, (ink) => inks.push(ink));
    expect(inks).toHaveLength(12 * 8);
    for (const ink of inks) {
      if (ink === FOIL_WHITE) continue;
      expect(Math.floor(ink / 4)).toBeLessThan(HOLO_INKS.length);
      expect(foilInkRgb(ink)).toHaveLength(3);
    }
  });
});
