import type { Rarity } from '../game/wordGame';

// How a rarity grade LOOKS and how hard it lands (#163). The ladder itself — the names,
// the corpus fractions, the seconds — is the game's rule and lives in `game/wordGame.ts`;
// this is the presentation of it, and nothing here restates a rule: every value below is
// indexed by `rarityStep`, so adding or retuning a grade moves one table.

// --- the colours -----------------------------------------------------------------------
// COPIED from the app's existing palettes, never invented — the same rule (and the same
// method) as `LANE_COLORS`: take stops the app already uses and pin each hex to its source
// so nothing drifts silently (`rarity.test.ts`, mirroring `laneColors.test.ts`).
//
// FOUR constraints, all MEASURED in CIE76 dE rather than eyeballed (the numbers below were
// reproduced against the lane set's recorded 36.9 / 15.3 before any grade was judged):
//
//   - RED IS RESERVED FOR MISS. Every grade clears 37+ dE from `--danger`; ARCANE's pink is
//     the closest at 37.75, which is still wider than the lane set's own 36.9 minimum, and
//     the two can never co-occur — a guess is a claim or a miss, never both.
//   - `--accent` blue is THE DAY'S WORD, which is the very thing the label floats on top of.
//     Every grade clears 58+ dE from it. (Progress-ramp blue was the obvious "rare" pick
//     and was rejected at 14.75 dE — an overlap, not a coexistence.)
//   - `--hole` gold is "you" AND the `+Ns` clock gain that fires in the SAME beat as this
//     label. Every grade clears 90+ dE. (Orange, the loot convention's legendary tier, was
//     rejected at 33.92.)
//   - LEGIBILITY: the label renders at the float's small pixel size, so 4.5:1 on `--bg` is
//     the bar. Progress-ramp violet — the intuitive "deep" pick for OBSCURE — FAILS it at
//     3.64:1, and indigo at 3.00:1; the heat ramp's electric violet clears at 5.04 and is
//     the only readable purple in the whole inventory.
//
// The set's minimum pairwise separation is 36.99 dE, and the hue runs monotonically around
// the wheel (green → cyan → violet → pink), stopping deliberately short of MISS's red — so
// the ladder reads as an escalation and no two grades blur into one payoff colour.
export const RARITY_COLORS: Record<Rarity, string> = {
  // --muted: the app's own quiet voice, and the only near-neutral in the inventory. It
  // reads as "no grade awarded", which is what COMMON means.
  COMMON: '#c4c9d8',
  // progress-ramp green: the first chromatic step off the grey, and the loot ladder every
  // player already carries in from elsewhere.
  UNCOMMON: '#23dc91',
  // progress-ramp cyan: the blue-family colour that keeps its distance from the solved blue
  // the label is drawn over.
  RARE: '#2ad2eb',
  // heat-ramp electric violet: deep and hidden, and the ladder's biggest lightness drop —
  // where it visibly leaves the everyday half.
  OBSCURE: '#c834ff',
  // progress-ramp pink: the loudest identity colour the app owns, for the rarest thing a
  // run can turn up.
  ARCANE: '#ef4f97',
};

// MISS wears the app's danger red — the one colour this ladder is not allowed to borrow.
// Kept as a constant beside the grades so the reservation is stated where it is enforced.
export const MISS_COLOR = '#ff1f54';

// --- the intensity ---------------------------------------------------------------------
// What makes ARCANE FEEL more than COMMON, as one table indexed by `rarityStep` rather than
// five rules. Five channels, because two of them have to survive `prefers-reduced-motion`
// on their own: that rule collapses DURATIONS but keeps DELAYS (see the reduced-motion note
// in index.css), so a ladder built only out of movement would not exist at all for a player
// who asked for none.
//
//   scale  — font-size multiplier of `--hit-base`. STATIC: survives reduced motion.
//   holdMs — how long it SITS ON THE WORD before leaving. A DELAY: survives reduced motion,
//            and the channel that matters most, because the label's whole job is to be read.
//   drop   — how far ABOVE the word it falls from, px. The label lands ON the word and rests
//            there (decided 2026-08-09) — a grade is a verdict on the guess, not a footnote
//            beside it — so this is where the stamp comes DOWN from, not where it stops.
//   rise   — how far it flies when it leaves, straight up, px. Motion.
//   punch  — the scale it arrives at, before settling to 1. Motion.
//   shake  — multiplier on the word's own shake amplitude. Motion.
//   wave   — the LETTER WAVE: the day's word ripples letter by letter, at this amplitude in
//            px. 0 is off. It arrives at RARE and grows from there — the top half of the
//            ladder does something the bottom half simply does not do, which reads as a
//            different KIND of event rather than a louder one. It is also the only channel
//            here that costs no width, which is what lets the ladder keep climbing on a
//            phone (see the note on the size cap below).
//
// RARE is deliberately the anchor: its punch (1.35) is what every float in the app did
// before this, so the ladder was tuned OUTWARD from the known-good middle rather than
// invented at both ends.
//
// THE LADDER IS TUNED AGAINST THE WORD, not in the abstract (retuned 2026-08-09). The label
// lands ON the day's word, which `fitWord` draws at up to SUBJECT_PX (40), so ARCANE reads
// as a stamp of comparable weight rather than something that swallows what it is about — it
// tops out around the word's own size, where a steeper ladder had it at half again.
//
// The sizes are ALSO capped by the label's own width. A grade name is a WORD — `UNCOMMON` is
// 8 characters, `OBSCURE` 7 — so `.rarity-hit` takes the SMALLER of `base x scale` and what
// the column can hold, exactly as `fitWord` does for the route drawing's words. At these
// sizes the cap no longer bites at any width; it stays as the guard that a future size bump
// cannot silently run off a phone, and the ladder is tuned so that if it ever does bite the
// ORDER still holds — a capped OBSCURE must never render smaller than an uncapped RARE.
export interface RarityHitStyle {
  scale: number;
  holdMs: number;
  drop: number;
  rise: number;
  punch: number;
  shake: number;
  wave: number;
}

export const RARITY_HIT: readonly RarityHitStyle[] = [
  { scale: 1, holdMs: 220, drop: 22, rise: 100, punch: 1.25, shake: 0.6, wave: 0 }, // COMMON
  { scale: 1.15, holdMs: 340, drop: 26, rise: 112, punch: 1.3, shake: 0.85, wave: 0 }, // UNCOMMON
  { scale: 1.35, holdMs: 500, drop: 32, rise: 128, punch: 1.35, shake: 1.1, wave: 4 }, // RARE
  { scale: 1.6, holdMs: 700, drop: 39, rise: 148, punch: 1.4, shake: 1.45, wave: 6 }, // OBSCURE
  { scale: 1.85, holdMs: 950, drop: 47, rise: 172, punch: 1.45, shake: 1.9, wave: 9 }, // ARCANE
];

// The label's resting TILT, in degrees (decided 2026-08-09). It leans a random way on every
// hit — the sign is a coin flip and the amount lands somewhere in this band — so a run of
// guesses reads as a stack of hand-thrown notes rather than one stamp printed over and over.
// Small on purpose: the type is a pixel font and rotation is the one transform it cannot
// survive much of (a diagonal edge on a glyph built out of squares reads as a rendering
// fault long before it reads as an angle).
export const HIT_TILT_MIN_DEG = 3;
export const HIT_TILT_MAX_DEG = 8;

// One roll. Called once per hit, in the submit handler, so a re-render never re-tilts a
// label that is already on screen.
export function rollHitTilt(): number {
  const sign = Math.random() < 0.5 ? -1 : 1;
  return sign * (HIT_TILT_MIN_DEG + Math.random() * (HIT_TILT_MAX_DEG - HIT_TILT_MIN_DEG));
}

// A miss is the quietest thing that can happen: it costs nothing but the seconds spent
// typing it, so it lands at the bottom of the ladder — in red, saying MISS, which no size
// is needed to make unmissable.
export const MISS_HIT = RARITY_HIT[0];
