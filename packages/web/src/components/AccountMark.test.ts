// CONTRACT: the code prompt's six inks are legible.
//
// A filled code key is struck SOLID in its `CODE_INKS` ink, and the DIGIT the player just
// typed is cut out of it in the page's own ground — so the pair a reader has to tell apart
// is the ink and that ground. The inks are `AVATAR_PALETTES` entries addressed rather than
// copied — that is the rule that keeps the prompt and the churning tile above it in one
// palette — and the walk is free to be retuned. What is not free is the FLOOR: the row
// opened on `AVATAR_PALETTES[1].bg` (#8f06ff) at 3.50:1, which passes only as LARGE text,
// beside a cyan at 16:1.
//
// So this pins the PROPERTY rather than the hexes: every ink clears WCAG AA for body text
// against the ground its digit is cut in, and there are six distinct ones. A reordered or
// re-picked walk is fine; one that reaches back into the palettes' dark grounds is not.

import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTES } from '@whippin/shared';
import { CODE_INKS } from './AccountMark';

// The digit is cut out of the key in the page ground, `--bg`.
const GROUND = '#050507';

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the code prompt inks', () => {
  it('are all AVATAR_PALETTES colours, addressed rather than copied', () => {
    const palette = new Set(AVATAR_PALETTES.flatMap((p) => [p.bg, p.fg]));
    for (const ink of CODE_INKS) expect(palette.has(ink)).toBe(true);
  });

  it('fills every cell of the code', () => {
    expect(CODE_INKS).toHaveLength(6);
    expect(new Set(CODE_INKS).size).toBe(6);
  });

  it('every one clears AA body text against the ground its digit is cut in', () => {
    // Reported as a LIST so a failure names the offending ink and its ratio, rather than
    // stopping at the first one with a bare "expected false to be true".
    const weak = CODE_INKS.map((ink) => ({ ink, ratio: Number(contrast(ink, GROUND).toFixed(2)) }))
      .filter((entry) => entry.ratio < 4.5);
    expect(weak).toEqual([]);
  });
});
