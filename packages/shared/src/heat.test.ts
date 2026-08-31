// CONTRACT: the app's ONE gradient runs WEIRD → CALM (user-decided 2026-08-17,
// superseding the iron-bow thermal ramp): solving is restoring peace to a weird
// sentence, so the scale starts at RED (maximally weird — and MISS, brought back to red
// by the same decision) and runs through amber, coral and rose-orchid into the cobalt. Pinned here:
//
//   - the gradient TERMINATES ON THE MISS COLOUR at the weird end: heatColor(0) IS
//     MISS_COLOR — one constant — and the 100-exponent cap collapses every far rank onto
//     that terminus, so a 100-away guess and a MISS share the colour and only the label
//     differs (the structural rules that survived the iron bow);
//   - the calm end is COBALT and the weird end is RED — peace and weirdness are the
//     metaphor's two poles — and everything between stays legible on `--bg`;
//   - a reconstruction % reads STRAIGHT onto the scale (2026-08-16), so the run ruler
//     (screen AND share card) spends the whole gradient and ends on the rank-0 calm;
//   - `progressEmoji` is the scale's plain-text twin — the share text's row must read as
//     the SAME scale as the ruler it stands in for: weird, draining, calm, in order,
//     never doubling back.

import { describe, it, expect } from 'vitest';
import {
  HIT_HEAT_CAP,
  MISS_COLOR,
  heatColor,
  progressEmoji,
  progressHeatColor,
  rankHeatColor,
} from './heat';

const rgb = (color: string): [number, number, number] => {
  const [r, g, b] = color.match(/\d+/g)!.map(Number);
  return [r, g, b];
};
const hexToRgbString = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

// WCAG relative luminance, for the legibility claim below.
function luminance(color: string): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(color);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const BG_LUMINANCE = luminance('rgb(5, 5, 7)'); // --bg #050507
const contrastOnBg = (color: string) =>
  (Math.max(luminance(color), BG_LUMINANCE) + 0.05) / (Math.min(luminance(color), BG_LUMINANCE) + 0.05);

describe('the weird→calm gradient', () => {
  it('terminates exactly ON the MISS colour at the weird end', () => {
    expect(heatColor(0)).toBe(hexToRgbString(MISS_COLOR));
    expect(heatColor(0)).toBe('rgb(255, 61, 46)'); // #ff3d2e red
  });

  it('weird is RED, calm is a BLUE — the metaphor two poles', () => {
    const [wr, , wb] = rgb(heatColor(0));
    expect(wr).toBeGreaterThan(wb); // red: warm, blue-poor
    const [cr, , cb] = rgb(heatColor(1));
    expect(cb).toBeGreaterThan(cr); // cobalt: blue-led
    expect(heatColor(1)).toBe('rgb(74, 106, 255)'); // #4a6aff — the web's --solve cobalt
  });

  it('drains monotonically from the amber on: blueness only ever rises toward calm', () => {
    // The directional promise, from the amber stop up (the red→amber opening is the one
    // deliberate exception — red is WEIRDER than yellow, not bluer): b - r never
    // decreases as heat rises, so the walk reads as one drain, no doubling back.
    let previous = -Infinity;
    for (let t = 0.22; t <= 1.0001; t += 0.05) {
      const [r, , b] = rgb(heatColor(t));
      expect(b - r).toBeGreaterThanOrEqual(previous);
      previous = b - r;
    }
  });

  it('stays legible everywhere on --bg — the calm palette has no dim region', () => {
    for (let t = 0; t <= 1.0001; t += 0.025) {
      expect(contrastOnBg(heatColor(t))).toBeGreaterThan(4.5);
    }
  });

  it('clamps heat outside [0,1] instead of running off the scale', () => {
    expect(heatColor(-1)).toBe(heatColor(0));
    expect(heatColor(2)).toBe(heatColor(1));
  });
});

describe('the rank scale stops at the 100 exponent — on the MISS colour itself', () => {
  it('caps at 100', () => {
    expect(HIT_HEAT_CAP).toBe(100);
  });

  it('a guess 1000 away, a guess 100 away and a MISS are the same level of weird', () => {
    expect(rankHeatColor(1000)).toBe(rankHeatColor(100));
    expect(rankHeatColor(100)).toBe(hexToRgbString(MISS_COLOR));
  });

  it('owns one absolute logarithmic denominator for every caller', () => {
    const rank = 50;
    expect(rankHeatColor(rank)).toBe(
      heatColor(1 - Math.log(rank + 1) / Math.log(HIT_HEAT_CAP + 1)),
    );
  });

  it('rank 0 is the calm end — the colour a solve lands on', () => {
    expect(rankHeatColor(0)).toBe(heatColor(1));
  });
});

describe('a progress % is the scale, read straight', () => {
  it('maps `n%` linearly onto the scale', () => {
    for (let pct = 0; pct <= 100; pct += 1) {
      expect(progressHeatColor(pct)).toBe(heatColor(pct / 100));
    }
  });

  it('starts on the weird red and lands the solve on the cobalt', () => {
    expect(progressHeatColor(0)).toBe(hexToRgbString(MISS_COLOR));
    expect(progressHeatColor(100)).toBe(heatColor(1));
    // The calm end is what a rank-0 exponent wears: a finished run ends on the peace it
    // restored.
    expect(progressHeatColor(100)).toBe(rankHeatColor(0));
  });

  it('clamps outside 0..100 instead of running off the scale', () => {
    expect(progressHeatColor(-20)).toBe(progressHeatColor(0));
    expect(progressHeatColor(200)).toBe(progressHeatColor(100));
  });
});

describe('progressEmoji — the scale in plain text', () => {
  it('walks weirdest, weird, strange, calm — and never returns', () => {
    const seen: string[] = [];
    for (let pct = 0; pct <= 100; pct += 1) {
      const e = progressEmoji(pct);
      if (e !== seen[seen.length - 1]) {
        expect(seen).not.toContain(e); // a repeat would make the row read backwards
        seen.push(e);
      }
    }
    expect(seen).toEqual(['🟥', '🟨', '🟪', '🟦']);
  });

  it('is half-open at each cut (the cut falls into the HIGHER band)', () => {
    expect([progressEmoji(14), progressEmoji(15)]).toEqual(['🟥', '🟨']);
    expect([progressEmoji(44), progressEmoji(45)]).toEqual(['🟨', '🟪']);
    expect([progressEmoji(74), progressEmoji(75)]).toEqual(['🟪', '🟦']);
  });

  it('never renders a solved run like an untouched one', () => {
    expect(progressEmoji(100)).not.toBe(progressEmoji(0));
  });

  it('covers the extremes and clamps beyond them', () => {
    expect(progressEmoji(0)).toBe('🟥');
    expect(progressEmoji(100)).toBe('🟦');
    expect(progressEmoji(-20)).toBe('🟥');
    expect(progressEmoji(200)).toBe('🟦');
  });

  it('emits one code point per value (the row survives plain-text clients)', () => {
    for (let pct = 0; pct <= 100; pct += 5) expect([...progressEmoji(pct)]).toHaveLength(1);
  });
});
