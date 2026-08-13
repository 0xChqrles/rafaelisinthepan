// CONTRACT: Word mode's rarity grades are painted in colours COPIED from the app's own
// palettes (#163). Copied means nothing catches drift if a ramp stop is retuned, which is
// what this pins: each hex still names the stop it was taken from, so a retune fails here
// and the choice gets made again on purpose instead of the ladder quietly speaking a stale
// palette.
//
// It also pins the two things that make the ladder MEAN anything, both of which a future
// colour edit could silently break:
//   - RED IS RESERVED FOR MISS. No grade may drift into it.
//   - the grades must stay mutually distinguishable, and clear of the two colours the
//     label is drawn next to (`--accent`, the day's word it floats on; `--hole`, the
//     `+Ns` clock gain that fires in the same beat).
// Measured in CIE76 dE.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { heatColor, progressColor, WORD_RARITY_COLORS } from '@whippin/shared';
import { RARITY_COLORS, MISS_COLOR, SLASH_ART, STRIKE_ARTS, STRUCK_MS, strikeFor } from './rarity';
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

// The reserved colours, READ straight out of index.css :root. A hand-copied hex checked
// against another hand-copy pins nothing: a
// `--danger` retune has to fail HERE so the reservation gets re-decided on purpose.
const rootCss = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
function rootVar(name: string): string {
  const m = new RegExp(`^\\s*${name}: (#[0-9a-f]{6})`, 'm').exec(rootCss);
  if (!m) throw new Error(`${name} is no longer a plain hex in index.css :root`);
  return m[1];
}
const DANGER = rootVar('--danger'); // MISS
const ACCENT = rootVar('--accent'); // the day's word, which the label floats ON
const HOLE = rootVar('--hole'); // "you", and the +Ns clock gain fired in the same beat

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
    // COMMON is --muted, read from index.css like the reserved colours above.
    expect(RARITY_COLORS.COMMON).toBe(rootVar('--muted'));
    expect(Object.keys(SOURCES)).toHaveLength(RARITY_NAMES.length);
  });

  it('RED stays reserved for MISS', () => {
    expect(MISS_COLOR).toBe(DANGER);
    // 36.9 is the separation the whole set was measured to hold; red is no exception.
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

  it("the OG card's chip palette is this ladder, pinned (the shared copy cannot drift)", () => {
    // cardSvg.ts carries a one-way COPY of these colours (ladder order) so the share card
    // can paint its chip row without importing the web; this is the identity that makes
    // the copy safe — retune a grade here and the card's copy fails until it is re-copied.
    expect(WORD_RARITY_COLORS).toEqual(RARITY_NAMES.map((name) => RARITY_COLORS[name]));
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

// NOT here: a grade's share-text BEAD. That is the text medium's presentation and lives
// with the composition that uses it (`game/share.ts`), tested in `share.test.ts`.

// The other half of the presentation: a rarer grade must read as more. Since the claim
// feedback became a SLASH (2026-08-09) that is carried by WHICH SHEET lands (a strike is
// one blow of one sheet since 2026-08-11, when the RARE cross and the whole multi-blow
// machinery retired on the user's call), and it is asserted as a rule rather than a table
// of numbers, so the mapping stays a knob.
describe('the strike escalates with the ladder', () => {
  // How big a strike IS: its sheet's place on the escalation. Ranked as EVENTS, never by
  // how long they run — the burst spends half the old cross's time on screen and is still
  // the bigger thing, so reading intensity off a clock would rank the ladder backwards.
  const weight = (name: (typeof RARITY_NAMES)[number]): number =>
    STRIKE_ARTS.indexOf(strikeFor(name));

  it('never strikes a rarer find more softly', () => {
    const w = RARITY_NAMES.map(weight);
    // Every sheet is on the escalation, and the order of that list IS the ranking.
    expect(w.every((art) => art >= 0)).toBe(true);
    for (let i = 1; i < w.length; i += 1) {
      expect(w[i] >= w[i - 1], `${RARITY_NAMES[i]} vs ${RARITY_NAMES[i - 1]}`).toBe(true);
    }
    // The two ends, so the ladder cannot flatten into one gesture unnoticed.
    expect(strikeFor(RARITY_NAMES[0]), 'the commonest grade is a single cut').toBe(SLASH_ART);
    expect(weight(RARITY_NAMES[RARITY_NAMES.length - 1]), 'the rarest wears the last sheet')
      .toBe(STRIKE_ARTS.length - 1);
    // And it really does climb — a table this small could go monotonic by being constant.
    expect(new Set(w).size).toBeGreaterThan(2);
  });

  it('the word lets go before the sheet ends', () => {
    // The recoil and the colour last STRUCK_MS and no sheet is shorter: the blow ends on a
    // word already back at rest, which is what makes a sheet's remaining frames read as
    // dissipation rather than as the hit still happening.
    expect(STRUCK_MS).toBeGreaterThan(0);
    for (const art of STRIKE_ARTS) expect(STRUCK_MS, `${art.css || 'slash'}`).toBeLessThan(art.ms);
  });

  // NOT tested: the frame counts, the frame rate, or `ms = frames * SLASH_FRAME_MS`. The
  // counts and the rate are cosmetic tuning (the testing policy leaves them free to move),
  // and the product is the `art()` factory's own definition — asserting it back proves
  // nothing. What would be worth pinning — that a sheet's PNG really holds the declared
  // frame count — cannot be read from here (the per-frame geometry lives in index.css).
});
