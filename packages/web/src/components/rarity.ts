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
//   holdMs — extra time the label sits before it leaves. A DELAY: survives reduced motion.
//   lift   — where it comes to rest above the word's centre, px. STATIC once it lands, and
//            it has to grow with `scale`: these labels are WORDS, so at one fixed lift an
//            ARCANE (drawn at twice the base) sat squarely on the word and hid it. The rare
//            grades tower over the word instead of smothering it.
//   rise   — how far it drifts as it fades, px. Motion. Always well past `lift`.
//   punch  — the pop's peak scale. Motion.
//   shake  — multiplier on the word's own shake amplitude. Motion.
//
// RARE is deliberately the anchor: its punch (1.35) is what every float in the app did
// before this, so the ladder was tuned OUTWARD from the known-good middle rather than
// invented at both ends. The lifts run higher than the sentence game's 14 across the board
// because these labels are WORDS, several times wider than a two-digit distance, and a
// wide label resting where a narrow number rests covers the thing it is about.
export interface RarityHitStyle {
  scale: number;
  holdMs: number;
  lift: number;
  rise: number;
  punch: number;
  shake: number;
}

export const RARITY_HIT: readonly RarityHitStyle[] = [
  { scale: 1, holdMs: 0, lift: 12, rise: 40, punch: 1.15, shake: 0.6 }, // COMMON
  { scale: 1.25, holdMs: 120, lift: 16, rise: 48, punch: 1.25, shake: 0.8 }, // UNCOMMON
  { scale: 1.5, holdMs: 260, lift: 22, rise: 58, punch: 1.35, shake: 1 }, // RARE
  { scale: 1.75, holdMs: 420, lift: 30, rise: 70, punch: 1.5, shake: 1.3 }, // OBSCURE
  { scale: 2, holdMs: 600, lift: 40, rise: 86, punch: 1.7, shake: 1.7 }, // ARCANE
];

// A miss is the quietest thing that can happen: it costs nothing but the seconds spent
// typing it, so it lands at the bottom of the ladder — in red, saying MISS, which no size
// is needed to make unmissable.
export const MISS_HIT = RARITY_HIT[0];
