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
import { RARITY_COLORS, RARITY_HIT, MISS_COLOR, MISS_HIT } from './rarity';
import { RARITY_LADDER, RARITY_NAMES, rarityStep } from '../game/wordGame';

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

// The other half of the presentation: a grade must not merely LOOK different, it must LAND
// differently — the point of naming them at all. Asserted as a shape (monotonic, one row
// per grade), never as five typed-out numbers, so the table stays a tuning knob.
describe('rarity intensity escalates with the ladder', () => {
  it('has one row per grade, indexed by rarityStep', () => {
    expect(RARITY_HIT).toHaveLength(RARITY_LADDER.length);
    for (const name of RARITY_NAMES) expect(RARITY_HIT[rarityStep(name)]).toBeDefined();
  });

  it('every graded channel is strictly stronger at a rarer grade', () => {
    for (const channel of ['scale', 'holdMs', 'drop', 'rise', 'punch', 'shake'] as const) {
      const values = RARITY_HIT.map((row) => row[channel]);
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i], `${channel} at step ${i}`).toBeGreaterThan(values[i - 1]);
      }
    }
  });

  it('the letter WAVE is a threshold, not a dial: off at the bottom, on and growing above', () => {
    // The wave is the one channel that is absent rather than quiet at the common end —
    // which is the point of it. It makes the top of the ladder a different KIND of event
    // instead of a louder one, and it is why the ladder can keep climbing on a phone: a
    // ripple costs no width, where every other channel does.
    const waves = RARITY_HIT.map((row) => row.wave);
    expect(waves[0], 'the commonest grade does not ripple').toBe(0);
    // Once it starts it never stops and never weakens.
    const firstOn = waves.findIndex((w) => w > 0);
    expect(firstOn).toBeGreaterThan(0);
    for (let i = firstOn; i < waves.length; i += 1) {
      expect(waves[i], `wave at step ${i}`).toBeGreaterThan(i === firstOn ? 0 : waves[i - 1]);
    }
  });

  // The label is a WORD, and the rarest are drawn several times the base size, so the
  // ladder can only climb as far as the narrowest column holds. `.rarity-hit` caps the
  // size at `room / (glyphs x punch)`; this pins the thing that cap can silently break —
  // if two grades both cap, the rarer one must still render LARGER, or the ladder inverts
  // on exactly the screens where it matters most.
  it('survives its own width cap at 320px without inverting', () => {
    const ROOM = 320 - 28; // the page inset a side, i.e. what `--hit-room` resolves to
    const BASE = 16; // `.word-subject .rarity-hit` at the mobile breakpoint
    const LABELS = [...RARITY_NAMES];
    const rendered = RARITY_HIT.map((row, i) =>
      Math.min(BASE * row.scale, ROOM / (LABELS[i].length * row.punch)),
    );
    for (let i = 1; i < rendered.length; i += 1) {
      expect(rendered[i], `${LABELS[i]} vs ${LABELS[i - 1]} at 320px`).toBeGreaterThan(
        rendered[i - 1],
      );
    }
    // And nothing overruns the screen at the loudest frame of its pop.
    rendered.forEach((size, i) => {
      expect(size * LABELS[i].length * RARITY_HIT[i].punch, `${LABELS[i]} peak width`)
        .toBeLessThanOrEqual(ROOM + 0.001);
    });
  });

  it('keeps a channel that survives reduced motion', () => {
    // The global reduced-motion rule collapses DURATIONS and keeps DELAYS, so a ladder
    // built only out of movement would not exist for a player who asked for none. Size is
    // static and the hold is a delay: between them the escalation always lands.
    const [common] = RARITY_HIT;
    const arcane = RARITY_HIT[RARITY_HIT.length - 1];
    expect(arcane.scale).toBeGreaterThan(common.scale);
    expect(arcane.holdMs).toBeGreaterThan(common.holdMs);
  });

  it('a MISS is the quietest thing that can land', () => {
    expect(MISS_HIT).toBe(RARITY_HIT[0]);
  });
});
