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

// --- what a grade LOOKS like ------------------------------------------------------------
// Two channels, and no more, because the feedback DOES NOT ANIMATE (2026-08-09): several
// choreographies were tried on it — a pop, a stamp landing on the word, a shockwave through
// the letters — and all were rejected, so the drop/rise/punch/shake/wave that fed them are
// gone with them. What is left is what a grade IS on screen: how big, and how long.
//
//   scale  — font-size multiplier of `--hit-base`.
//   holdMs — how long the label stays before it goes.
//
// THE LADDER IS TUNED AGAINST THE WORD. The label sits on the day's word, which `fitWord`
// draws at up to SUBJECT_PX (40), and it is a badge ON that word — so it stays clearly
// SMALLER than it, desktop 18→30px and mobile 14→24px. Earlier cuts overshot in both
// directions: one so small the grades barely differed, one where ARCANE matched the word and
// swallowed it.
//
// The size is ALSO capped by the label's own width. A grade name is a WORD — `UNCOMMON` is 8
// characters, `OBSCURE` 7 — so `.rarity-hit` takes the SMALLER of `base x scale` and what the
// column can hold, exactly as `fitWord` does for the route drawing's words. At these sizes
// the cap does not bite at any width; it stays as the guard that a future size bump cannot
// silently run off a phone, and the ladder is tuned so that if it ever does bite the ORDER
// still holds — a capped OBSCURE must never render smaller than an uncapped RARE.
export interface RarityHitStyle {
  scale: number;
  holdMs: number;
}

export const RARITY_HIT: readonly RarityHitStyle[] = [
  { scale: 1, holdMs: 700 }, // COMMON
  { scale: 1.15, holdMs: 850 }, // UNCOMMON
  { scale: 1.32, holdMs: 1050 }, // RARE
  { scale: 1.5, holdMs: 1300 }, // OBSCURE
  { scale: 1.68, holdMs: 1600 }, // ARCANE
];


// A miss is the quietest thing that can happen: it costs nothing but the seconds spent
// typing it, so it lands at the bottom of the ladder — in red, saying MISS, which no size
// is needed to make unmissable.
export const MISS_HIT = RARITY_HIT[0];
