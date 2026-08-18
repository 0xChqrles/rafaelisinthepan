// CONTRACT: Word mode's rarity grades are the stamp-ink ladder authored for the calm
// redesign (2026-08-17). What this pins is the two things that make the ladder MEAN
// anything, both of which a future colour edit could silently break:
//   - THE MISS COLOUR IS NO GRADE'S (the reservation red carried until 2026-08-17).
//   - the grades must stay mutually distinguishable, and clear of the colours the label
//     is drawn next to (`--solve`, the day's word it floats on; `--danger`, the timer).
// Measured in CIE76 dE; the thresholds below pin those perceptual separations.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MISS_COLOR, WORD_RARITY_COLORS, heatColor } from '@whippin/shared';
import { RARITY_COLORS, SLASH_ART, STRIKE_ARTS, STRUCK_MS, strikeFor } from './rarity';
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
const DANGER = rootVar('--danger'); // timer warning and invalid feedback
const SOLVE = rootVar('--solve'); // the ink blue: the day's word and every solved word

// Where each grade comes from: the muted ladder is AUTHORED for the calm palette (no
// longer copies of ramp stops — those ramps are gone), keeping the electric set's hue
// walk so a returning player's intuition survives. COMMON alone tracks a live source.
const SOURCES: Record<string, string> = {
  COMMON: 'authored: cool slate-lavender',
  UNCOMMON: 'authored: LED cyan',
  RARE: 'authored: azure',
  OBSCURE: 'authored: violet',
  ARCANE: 'authored: laser magenta',
};

describe('rarity colours stay authored for the stamp-ink palette', () => {
  it('there is exactly one colour per grade', () => {
    expect(Object.keys(RARITY_COLORS).sort()).toEqual([...RARITY_NAMES].sort());
  });

  it('each grade still names its source', () => {
    // ALL FIVE are authored hexes since the aura ladder (2026-08-18 — COMMON left
    // --muted's warm grey for a cool slate that lives in the app's blue world), pinned
    // here so a hand-edit of one is still a deliberate act.
    expect(RARITY_COLORS.COMMON).toBe('#97a3c9');
    expect(RARITY_COLORS.UNCOMMON).toBe('#4fd2e8');
    expect(RARITY_COLORS.RARE).toBe('#64a0ff');
    expect(RARITY_COLORS.OBSCURE).toBe('#bd68ff');
    expect(RARITY_COLORS.ARCANE).toBe('#ff5ce0');
    expect(Object.keys(SOURCES)).toHaveLength(RARITY_NAMES.length);
  });

  it('MISS is the gradient\'s own WEIRD TERMINUS — the red the scale stops on', () => {
    // The standing rule (2026-08-17): the gradient terminates exactly ON the MISS colour —
    // one constant, living with the scale in @whippin/shared, pinned identical here.
    expect(hex(heatColor(0))).toBe(MISS_COLOR);
    // And it must stay LEGIBLE: MISS is critical feedback text.
    const bg = rootVar('--bg');
    const rel = (h: string) => {
      const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) =>
      (Math.max(rel(a), rel(b)) + 0.05) / (Math.min(rel(a), rel(b)) + 0.05);
    expect(contrast(MISS_COLOR, bg)).toBeGreaterThan(5);
    // A red MISS floats over the cobalt day word in Word mode and the pale-draft
    // holes in the sentence — measured 125 and 100 dE.
    expect(deltaE(MISS_COLOR, SOLVE)).toBeGreaterThan(50);
    expect(deltaE(MISS_COLOR, rootVar('--hole'))).toBeGreaterThan(50);
  });

  it('the MISS colour is no grade\'s (the reservation red used to carry)', () => {
    // A float shows a grade name OR MISS, same slot same size, seconds apart — the two
    // must never read as one colour. 30 is the muted world's re-measured bar.
    for (const name of RARITY_NAMES) {
      expect(deltaE(RARITY_COLORS[name], MISS_COLOR), `${name} vs MISS`).toBeGreaterThan(30);
    }
    // Red stayed on screen (the timer's warning, the invalid shake): re-measured at 30+.
    for (const name of RARITY_NAMES) {
      expect(deltaE(RARITY_COLORS[name], DANGER), `${name} vs danger red`).toBeGreaterThan(30);
    }
  });

  it('no grade collides with the colours it is rendered beside', () => {
    for (const name of RARITY_NAMES) {
      // The label floats ON the day's word, drawn in the solve ink. 25 is the muted
      // world's bar (OBSCURE's violet the closest at 25.3, measured).
      expect(deltaE(RARITY_COLORS[name], SOLVE), `${name} vs the day's word`).toBeGreaterThan(25);
    }
  });

  it("the OG card's chip palette is this ladder, pinned (the shared copy cannot drift)", () => {
    // cardSvg.ts carries a one-way COPY of these colours (ladder order) so the share card
    // can paint its chip row without importing the web; this is the identity that makes
    // the copy safe — retune a grade here and the card's copy fails until it is re-copied.
    expect(WORD_RARITY_COLORS).toEqual(RARITY_NAMES.map((name) => RARITY_COLORS[name]));
  });

  it('the grades stay mutually distinguishable', () => {
    // OBSCURE and ARCANE are the pair most at risk — two muted purples blur into one
    // payoff colour at the float's size. 25 is the muted world's bar (25.5 measured).
    let min = Infinity;
    for (let i = 0; i < RARITY_NAMES.length; i += 1) {
      for (let j = i + 1; j < RARITY_NAMES.length; j += 1) {
        min = Math.min(min, deltaE(RARITY_COLORS[RARITY_NAMES[i]], RARITY_COLORS[RARITY_NAMES[j]]));
      }
    }
    expect(min).toBeGreaterThan(25);
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
