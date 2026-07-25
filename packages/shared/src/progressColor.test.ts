// CONTRACT: progressEmoji (packages/shared/src/progressColor.ts) is the ramp's plain-text
// twin — the share text's emoji row must read as the SAME ramp as the run ruler it stands in
// for. So it has to walk the ramp's own order, never double back on a color it already left,
// and in particular never render a finished run's tail as its untouched head.

import { describe, it, expect } from 'vitest';
import { progressColor, progressEmoji } from './progressColor';

// The ramp's stops, in order, with the emoji each should resolve to.
const STOPS: [number, string][] = [
  [15, '🟦'], // blue
  [30, '🟦'], // cyan (Unicode has no cyan square)
  [40, '🟩'], // green
  [50, '🟨'], // gold
  [60, '🟧'], // coral
  [70, '🟥'], // pink
  [80, '🟪'], // magenta
  [90, '🟪'], // violet
  [100, '🟪'], // indigo
];

describe('progressEmoji — the progress ramp in plain text', () => {
  it('resolves every ramp stop to its nearest square', () => {
    for (const [v, emoji] of STOPS) expect(progressEmoji(v)).toBe(emoji);
  });

  it('walks the ramp in order and never returns to a color it has left', () => {
    const seen: string[] = [];
    for (let v = 0; v <= 100; v += 1) {
      const e = progressEmoji(v);
      if (e !== seen[seen.length - 1]) {
        expect(seen).not.toContain(e); // a repeat would make the row read backwards
        seen.push(e);
      }
    }
    expect(seen).toEqual(['🟦', '🟩', '🟨', '🟧', '🟥', '🟪']);
  });

  it('never renders a solved run like an untouched one (the ramp closes near its start)', () => {
    // progressColor's indigo tail sits close to its blue head — the emoji must not.
    expect(progressEmoji(100)).not.toBe(progressEmoji(0));
  });

  it('covers the extremes and clamps beyond them', () => {
    expect(progressEmoji(0)).toBe('🟦');
    expect(progressEmoji(100)).toBe('🟪');
    expect(progressEmoji(-20)).toBe('🟦');
    expect(progressEmoji(200)).toBe('🟪');
  });

  it('is half-open at each boundary (the boundary falls into the HIGHER band)', () => {
    expect([progressEmoji(34), progressEmoji(35)]).toEqual(['🟦', '🟩']);
    expect([progressEmoji(44), progressEmoji(45)]).toEqual(['🟩', '🟨']);
    expect([progressEmoji(54), progressEmoji(55)]).toEqual(['🟨', '🟧']);
    expect([progressEmoji(64), progressEmoji(65)]).toEqual(['🟧', '🟥']);
    expect([progressEmoji(74), progressEmoji(75)]).toEqual(['🟥', '🟪']);
  });

  it('emits one code point per value (the row survives plain-text clients)', () => {
    for (const [v] of STOPS) expect([...progressEmoji(v)]).toHaveLength(1);
  });
});

describe('progressColor — the ramp itself', () => {
  it('interpolates between stops and clamps outside them', () => {
    expect(progressColor(15)).toBe('rgb(35, 132, 242)');
    expect(progressColor(100)).toBe('rgb(70, 66, 232)');
    expect(progressColor(0)).toBe(progressColor(15)); // below the first stop
    expect(progressColor(200)).toBe(progressColor(100)); // above the last
  });
});
