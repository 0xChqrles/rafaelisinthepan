// CONTRACT (light): the share-card SVG (packages/shared/src/cardSvg.ts) must render the
// player's RUN RULER — one cell per counted try on the SHARED progress ramp (so the card
// matches the on-screen ruler), a tick per solving try with the dropped hole's sentence
// index under it — plus the score and the puzzle id. (Exact positions/sizes are cosmetic
// and not asserted; they get tuned against the rasterized PNG.)

import { describe, it, expect } from 'vitest';
import { renderCardSvg, CARD_WIDTH } from './cardSvg';
import { progressColor } from './progressColor';

describe('renderCardSvg', () => {
  const data = {
    lang: 'en',
    dayNumber: 123,
    score: 6,
    trajectory: [8, 8, 33, 33, 70, 100],
    solvedAt: [3, 6, 5],
  };

  it('renders one <rect> per counted try (plus the background and one per tick)', () => {
    const svg = renderCardSvg(data);
    const rects = svg.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(1 + data.trajectory.length + 3); // bg + 6 cells + 3 ticks
  });

  it('colors each cell with the SHARED progress ramp (matches the on-screen ruler)', () => {
    const svg = renderCardSvg(data);
    for (const pct of data.trajectory) expect(svg).toContain(`fill="${progressColor(pct)}"`);
  });

  it('marks each solved secret with its sentence index (1..3), in sentence order', () => {
    const svg = renderCardSvg(data);
    const indices = [...svg.matchAll(/font-size="28"[^>]*>(\d+)</g)].map((m) => m[1]);
    expect(indices).toEqual(['1', '3', '2']); // ticks ordered by try: 3 -> hole 1, 5 -> 3, 6 -> 2
  });

  it('stacks the indices of several secrets dropped by ONE guess under a single tick', () => {
    const svg = renderCardSvg({ ...data, solvedAt: [6, 6, 6] });
    expect(svg.match(/<rect /g) ?? []).toHaveLength(1 + 6 + 1); // bg + cells + ONE tick
    const indices = [...svg.matchAll(/font-size="28"[^>]*>(\d+)</g)].map((m) => m[1]);
    expect(indices).toEqual(['1', '2', '3']); // all three, stacked
  });

  it('draws no tick for a secret the run never solved', () => {
    const svg = renderCardSvg({ ...data, solvedAt: [3, null, null] });
    expect(svg.match(/<rect /g) ?? []).toHaveLength(1 + 6 + 1);
    expect([...svg.matchAll(/font-size="28"[^>]*>(\d+)</g)].map((m) => m[1])).toEqual(['1']);
  });

  it('shows the try count (unit named — lower is better) and the puzzle id (#dayNumber, never a date)', () => {
    const svg = renderCardSvg(data);
    expect(svg).toContain('6 TRIES');
    expect(svg).toContain('#123');
  });

  it('uses the singular for one try', () => {
    expect(renderCardSvg({ ...data, score: 1 })).toContain('1 TRY');
  });

  it('localizes the unit by the token language (fr -> ESSAIS/ESSAI)', () => {
    expect(renderCardSvg({ ...data, lang: 'fr' })).toContain('6 ESSAIS');
    expect(renderCardSvg({ ...data, lang: 'fr', score: 1 })).toContain('1 ESSAI');
  });

  it('falls back to en for an unknown language', () => {
    expect(renderCardSvg({ ...data, lang: 'zz' })).toContain('6 TRIES');
  });

  it('is a well-formed standalone svg at OG dimensions', () => {
    const svg = renderCardSvg(data);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('keeps a long run (300 tries) inside the card, one cell per try, no gaps', () => {
    const trajectory = Array.from({ length: 300 }, (_, i) => (100 * (i + 1)) / 300);
    const svg = renderCardSvg({ lang: 'en', dayNumber: 300, score: 300, trajectory, solvedAt: [120, 240, 300] });
    const cells = [...svg.matchAll(/<rect x="([\d.]+)" y="180" width="([\d.]+)"/g)];
    expect(cells).toHaveLength(300);
    for (const [, x, w] of cells) {
      expect(Number(w)).toBeGreaterThanOrEqual(1); // never a zero-width sliver
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(CARD_WIDTH);
    }
    // Contiguous: each cell starts where the previous one ended — no seams in the bar.
    for (let i = 1; i < cells.length; i += 1) {
      expect(Number(cells[i][1])).toBe(Number(cells[i - 1][1]) + Number(cells[i - 1][2]));
    }
  });
});
