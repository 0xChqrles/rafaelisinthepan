// CONTRACT (light): the share-card SVG (packages/shared/src/cardSvg.ts) must render one
// heat-colored rect per square, the score, and the puzzle id — using the SHARED heat ramp
// so the card matches the on-screen grid. (Exact positions/sizes are cosmetic and not
// asserted; they get tuned against the rasterized PNG.)

import { describe, it, expect } from 'vitest';
import { renderCardSvg } from './cardSvg';
import { heatColor } from './heat';

describe('renderCardSvg', () => {
  const data = { dayNumber: 123, score: 42, squares: [8, 50, 100] };

  it('renders one <rect> per square (plus the background rect)', () => {
    const svg = renderCardSvg(data);
    const rects = svg.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(data.squares.length + 1); // 3 squares + 1 background
  });

  it('colors each square with the SHARED heat ramp (matches the on-screen grid)', () => {
    const svg = renderCardSvg(data);
    for (const pct of data.squares) expect(svg).toContain(`fill="${heatColor(pct / 100)}"`);
  });

  it('shows the try count (unit named — lower is better) and the puzzle id (#dayNumber, never a date)', () => {
    const svg = renderCardSvg(data);
    expect(svg).toContain('42 TRIES');
    expect(svg).toContain('#123');
  });

  it('uses the singular for one try', () => {
    expect(renderCardSvg({ ...data, score: 1 })).toContain('1 TRY');
  });

  it('is a well-formed standalone svg at OG dimensions', () => {
    const svg = renderCardSvg(data);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('handles the maximum 18 squares without overflowing the card width', () => {
    const svg = renderCardSvg({ dayNumber: 300, score: 300, squares: Array(18).fill(60) });
    // Every rect's x + width must stay within the 1200px canvas.
    const coords = [...svg.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)"/g)];
    expect(coords).toHaveLength(18);
    for (const [, x, w] of coords) expect(Number(x) + Number(w)).toBeLessThanOrEqual(1200);
  });
});
