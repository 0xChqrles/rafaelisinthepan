// CONTRACT: the code prompt's six inks are legible.
//
// `CODE_INKS` paints the DIGIT the player just typed, at 18px, on the code cell's own
// ground. They are `AVATAR_PALETTES` entries addressed rather than copied — that is the rule
// that keeps the prompt and the churning tile above it in one palette — and the walk is free
// to be retuned. What is not free is the FLOOR: the row opened on `AVATAR_PALETTES[1].bg`
// (#8f06ff) at 3.50:1, which passes only as LARGE text, beside a cyan at 16:1.
//
// So this pins the PROPERTY rather than the hexes: every ink clears WCAG AA for body text
// against the cell it is drawn in, and there are six distinct ones. A reordered or re-picked
// walk is fine; one that reaches back into the palettes' dark grounds is not.

import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTES } from '@whippin/shared';
import { CODE_INKS } from './AccountMark';

// `.code-cell` is `rgba(0, 0, 0, 0.28)` over the page ground `--bg` #050507.
const GROUND = '#050507';
const CELL_ALPHA = 0.28;

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
// The cell's ground: black at 28% over the page.
const CELL = (() => {
  const [r, g, b] = rgb(GROUND).map((c) => Math.round(c * (1 - CELL_ALPHA)));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
})();

describe('the code prompt inks', () => {
  it('are all AVATAR_PALETTES colours, addressed rather than copied', () => {
    const palette = new Set(AVATAR_PALETTES.flatMap((p) => [p.bg, p.fg]));
    for (const ink of CODE_INKS) expect(palette.has(ink)).toBe(true);
  });

  it('fills every cell of the code', () => {
    expect(CODE_INKS).toHaveLength(6);
    expect(new Set(CODE_INKS).size).toBe(6);
  });

  it('every one clears AA body text on the cell it is drawn in', () => {
    // Reported as a LIST so a failure names the offending ink and its ratio, rather than
    // stopping at the first one with a bare "expected false to be true".
    const weak = CODE_INKS.map((ink) => ({ ink, ratio: Number(contrast(ink, CELL).toFixed(2)) }))
      .filter((entry) => entry.ratio < 4.5);
    expect(weak).toEqual([]);
  });
});
