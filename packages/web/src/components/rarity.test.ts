// CONTRACT: Word mode's rarity grades are painted in colours COPIED from the app's own
// palettes (#163) — the same rule, and the same kind of pin, as the route map's lane
// colours. Copied means nothing catches drift if a ramp stop is retuned, which is what
// this pins: each hex still names the stop it was taken from, so a retune fails here and
// the choice gets made again on purpose instead of the ladder quietly speaking a stale
// palette.
//
// It also pins the two things that make the ladder MEAN anything, both of which a future
// colour edit could silently break:
//   - RED IS RESERVED FOR MISS. No grade may drift into it.
//   - the grades must stay mutually distinguishable, and clear of the two colours the
//     label is drawn next to (`--accent`, the day's word it floats on; `--hole`, the
//     `+Ns` clock gain that fires in the same beat).
// Measured in CIE76 dE, the same measure the lane set's recorded 36.9 was taken with.

import { describe, it, expect } from 'vitest';
import { heatColor, progressColor } from '@whippin/shared';
import {
  RARITY_COLORS,
  MISS_COLOR,
  DOUBLE_SLASH_FROM,
  SLASH_FRAMES,
  SLASH_FRAME_MS,
  SLASH_MS,
  STRUCK_MS,
  ULTRA_FRAMES,
  ULTRA_MS,
  ULTRA_SLASH_FROM,
  slashDelayMs,
  strikeDurationMs,
  strikeFor,
} from './rarity';
import { RARITY_NAMES } from '../game/wordGame';

function hex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

// hex -> CIE Lab (D65), so dE is a perceptual distance rather than an RGB one.
function lab(h: string): [number, number, number] {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [X, Y, Z].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// The reserved colours, straight out of index.css :root.
const DANGER = '#ff1f54'; // MISS
const ACCENT = '#2f7bff'; // the day's word, which the label floats ON
const HOLE = '#ffc400'; // "you", and the +Ns clock gain fired in the same beat

// Where each grade's hex was copied from. Anything not on a shared ramp is a CSS variable,
// named here so the source is never a mystery.
const SOURCES: Record<string, string> = {
  COMMON: '--muted',
  UNCOMMON: 'progress stop 40 (green)',
  RARE: 'progress stop 30 (cyan)',
  OBSCURE: 'heat stop 0.58 (electric violet)',
  ARCANE: 'progress stop 70 (pink)',
};

describe('rarity colours track the palette stops they were copied from', () => {
  it('there is exactly one colour per grade', () => {
    expect(Object.keys(RARITY_COLORS).sort()).toEqual([...RARITY_NAMES].sort());
  });

  it('each grade still names its source stop', () => {
    // If a ramp stop is retuned, this fails and the choice is made again on purpose.
    expect(RARITY_COLORS.UNCOMMON).toBe(hex(progressColor(40)));
    expect(RARITY_COLORS.RARE).toBe(hex(progressColor(30)));
    expect(RARITY_COLORS.OBSCURE).toBe(hex(heatColor(0.58)));
    expect(RARITY_COLORS.ARCANE).toBe(hex(progressColor(70)));
    // COMMON is --muted, which lives in CSS; nothing to read it from, so it is stated.
    expect(RARITY_COLORS.COMMON).toBe('#c4c9d8');
    expect(Object.keys(SOURCES)).toHaveLength(RARITY_NAMES.length);
  });

  it('RED stays reserved for MISS', () => {
    expect(MISS_COLOR).toBe(DANGER);
    // The lane set's own shipped minimum is 36.9; every grade clears that against red.
    for (const name of RARITY_NAMES) {
      expect(deltaE(RARITY_COLORS[name], DANGER), `${name} vs MISS red`).toBeGreaterThan(36.9);
    }
  });

  it('no grade collides with the colours it is rendered beside', () => {
    for (const name of RARITY_NAMES) {
      // The label floats ON the day's word, drawn in --accent.
      expect(deltaE(RARITY_COLORS[name], ACCENT), `${name} vs the day's word`).toBeGreaterThan(30);
      // The +Ns clock gain fires in the SAME beat as the label, in --hole gold.
      expect(deltaE(RARITY_COLORS[name], HOLE), `${name} vs the clock gain`).toBeGreaterThan(30);
    }
  });

  it('the grades stay mutually distinguishable', () => {
    // OBSCURE and ARCANE are the pair that matters most and the pair most at risk — two
    // bright purples blur into one payoff colour at the float's size.
    let min = Infinity;
    for (let i = 0; i < RARITY_NAMES.length; i += 1) {
      for (let j = i + 1; j < RARITY_NAMES.length; j += 1) {
        min = Math.min(min, deltaE(RARITY_COLORS[RARITY_NAMES[i]], RARITY_COLORS[RARITY_NAMES[j]]));
      }
    }
    expect(min).toBeGreaterThan(30);
  });
});

// The other half of the presentation: a rarer grade must read as more. Since the claim
// feedback became a SLASH (2026-08-09) that is carried by ONE thing — how many times the
// word is struck — and it is asserted as a rule rather than a table of numbers, so the
// threshold stays a knob.
describe('the strike escalates with the ladder', () => {
  // A cut, then a cross, then the burst. Ranked as EVENTS rather than by how long they run:
  // the burst spends less time on screen than the cross (350ms against 500) and is still the
  // bigger thing, so duration must not be read as the escalation.
  const step = (name: (typeof RARITY_NAMES)[number]) => {
    const s = strikeFor(name, RARITY_NAMES);
    return s.ultra ? 2 : s.blows - 1;
  };

  it('climbs cut -> cross -> burst, and never back down', () => {
    const steps = RARITY_NAMES.map(step);
    expect(steps[0], 'the commonest grade is a single cut').toBe(0);
    expect(steps[steps.length - 1], 'the rarest is the burst').toBe(2);
    // Never a smaller strike for a rarer find, at any grade.
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i], `${RARITY_NAMES[i]}`).toBeGreaterThanOrEqual(steps[i - 1]);
    }
    // And each threshold is where it SAYS it is, rather than wherever an array happened to
    // put it — including that the two never cross over (a grade cannot be both).
    expect(strikeFor(DOUBLE_SLASH_FROM, RARITY_NAMES)).toEqual({ ultra: false, blows: 2 });
    expect(strikeFor(ULTRA_SLASH_FROM, RARITY_NAMES).ultra).toBe(true);
    const belowCross = RARITY_NAMES[RARITY_NAMES.indexOf(DOUBLE_SLASH_FROM) - 1];
    expect(strikeFor(belowCross, RARITY_NAMES)).toEqual({ ultra: false, blows: 1 });
    const belowBurst = RARITY_NAMES[RARITY_NAMES.indexOf(ULTRA_SLASH_FROM) - 1];
    expect(strikeFor(belowBurst, RARITY_NAMES).ultra).toBe(false);
    expect(RARITY_NAMES.indexOf(ULTRA_SLASH_FROM)).toBeGreaterThan(
      RARITY_NAMES.indexOf(DOUBLE_SLASH_FROM),
    );
  });

  it('the blows never share the screen, and the word lets go between them', () => {
    // Two strikes at once read as one thick stroke, which is the opposite of what the second
    // blow is for. So the second starts only once the first has finished...
    expect(slashDelayMs(0)).toBe(0);
    expect(slashDelayMs(1)).toBe(SLASH_MS);
    // ...and the beat that makes a cross read as TWO hits rather than one long one belongs to
    // the WORD, which stops reacting before its blow's stroke ends. Without this the recoil
    // and the colour would run unbroken across both strokes, which is the one reading the
    // second blow exists to avoid.
    expect(STRUCK_MS).toBeLessThan(SLASH_MS);
    expect(STRUCK_MS).toBeGreaterThan(0);
    // The word must let go before the BURST ends too, or its one blow would hold the recoil
    // and the colour for the sheet's whole dissipation.
    expect(STRUCK_MS).toBeLessThan(ULTRA_MS);
    // ...and the whole thing runs as long as the blows it is made of. The ending beat waits
    // for whatever is still in the air; if this under-reported, the last strike of a run
    // would be cut off mid-swing to show the board.
    expect(strikeDurationMs({ ultra: false, blows: 1 })).toBe(SLASH_MS);
    expect(strikeDurationMs({ ultra: false, blows: 2 })).toBe(slashDelayMs(1) + SLASH_MS);
    expect(strikeDurationMs({ ultra: true, blows: 1 })).toBe(ULTRA_MS);
  });

  it('each sheet is walked frame for frame', () => {
    // If a constant and its sheet ever disagree the strike either stutters or ends early, and
    // nothing else would catch it. Both sheets run at ONE frame rate.
    expect(SLASH_MS).toBe(SLASH_FRAMES * SLASH_FRAME_MS);
    expect(SLASH_FRAMES).toBe(5);
    expect(ULTRA_MS).toBe(ULTRA_FRAMES * SLASH_FRAME_MS);
    expect(ULTRA_FRAMES).toBe(7);
  });
});
