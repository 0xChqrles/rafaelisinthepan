// CONTRACT (light): the share-card SVG (packages/shared/src/cardSvg.ts) must render the
// player's RUN RULER — one cell per counted try on the SHARED progress ramp (so the card
// matches the on-screen ruler), a tick per solving try with the dropped hole's sentence
// index under it — plus the score and the day's calendar date. (Exact positions/sizes are cosmetic
// and not asserted; they get tuned against the rasterized PNG.)

import { describe, it, expect } from 'vitest';
import { renderCardSvg, CARD_WIDTH } from './cardSvg';
import { dateForDayNumber } from './day';
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

  it('shows the try count (unit named — lower is better) and the day as its calendar date', () => {
    const svg = renderCardSvg(data);
    expect(svg).toContain('6 TRIES');
    // The token carries the day INDEX; the card draws the date that index IS — the server's
    // game day in every timezone (dateForDayNumber is dayNumber's inverse), never "#123"
    // and never the reader's local date.
    expect(svg).toContain(dateForDayNumber(123));
    expect(svg).toContain('1970-05-04');
    expect(svg).not.toContain('#123');
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

  it('bounds the rect count by the CARD, not by the token (a forged score can not blow it up)', () => {
    // The token's score field holds 15 bits, so a hand-built one can declare ~32k tries and
    // the decoder will hand us that many cells. Below one pixel per cell the extra rects are
    // invisible — they only stack — so the renderer must collapse them instead of asking the
    // rasterizer to draw 32k of them on every /og cache miss.
    const trajectory = Array.from({ length: 32_767 }, (_, i) => (100 * (i + 1)) / 32_767);
    const svg = renderCardSvg({ lang: 'en', dayNumber: 300, score: 32_767, trajectory, solvedAt: [1, 2, 3] });
    const cells = [...svg.matchAll(/<rect x="([\d.]+)" y="180" width="([\d.]+)"/g)];
    expect(cells.length).toBeLessThanOrEqual(CARD_WIDTH);
    // Still the same bar: contiguous, every cell at least a pixel, none past the edge.
    for (const [, x, w] of cells) {
      expect(Number(w)).toBeGreaterThanOrEqual(1);
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(CARD_WIDTH);
    }
    for (let i = 1; i < cells.length; i += 1) {
      expect(Number(cells[i][1])).toBe(Number(cells[i - 1][1]) + Number(cells[i - 1][2]));
    }
    // And it still spans the full bar — collapsing cells must not shorten the run.
    const last = cells[cells.length - 1];
    expect(Number(last[1]) + Number(last[2])).toBe(Number(cells[0][1]) + 1020);
  });
});
