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

// --- what a claim LOOKS like: a SLASH across the word ------------------------------------
// A find CUTS the word (decided 2026-08-09, replacing the grade name that used to stamp onto
// it). `assets/slash.png` is a 5-frame 36x46 sheet of a diagonal stroke that lands and
// dissipates; it is drawn at an exact integer scale as a MASK painted in the grade's colour,
// which is what the sheet's pure white is for — the same technique as the header globe.
//
// The GRADE is now carried by the slash's colour alone, and it is not the only place it is
// said: the run's history logs each find in its colour and the tally counts them by it. What
// the strike adds is the moment.
export const SLASH_FRAMES = 5;
export const SLASH_FRAME_MS = 50;
export const SLASH_MS = SLASH_FRAMES * SLASH_FRAME_MS;

// A rare find is struck TWICE, the second blow mirrored so the two cross. It is the same
// escalation the seconds ladder makes, said in one gesture rather than five sizes: below the
// threshold a find is a cut, at or above it a find is a cross.
export const DOUBLE_SLASH_FROM: Rarity = 'RARE';

export function slashesFor(rarity: Rarity, order: readonly Rarity[]): number {
  return order.indexOf(rarity) >= order.indexOf(DOUBLE_SLASH_FROM) ? 2 : 1;
}

// When blow `index` lands: the moment the one before it ends, with no pause between them
// (decided 2026-08-09, dropping a one-frame gap). The two strokes still never share the
// screen — that is what makes a cross read as being struck twice instead of once with a
// thicker stroke — but the daylight that says so belongs to the WORD, not to the sprite: it
// stops reacting a frame early (below), so the beat is there whether or not the art pauses.
export function slashDelayMs(index: number): number {
  return index * SLASH_MS;
}

// How long the WORD reacts to one blow — its recoil and the grade's colour on it. FOUR of the
// stroke's five frames, so the last frame of every blow lands on a word already back to rest
// (decided 2026-08-09). That is the whole beat between two hits now: the strokes run
// continuously, and what separates them is the word letting go and being struck again. It
// sits on the ART's own frame count rather than being an invented duration, because it is a
// statement about which frames of the stroke the word is answering.
export const STRUCK_FRAMES = 4;
export const STRUCK_MS = STRUCK_FRAMES * SLASH_FRAME_MS;

// How long a strike is on screen, so the screen can hold its ending beat for one.
export function slashDurationMs(slashes: number): number {
  return slashDelayMs(Math.max(0, slashes - 1)) + SLASH_MS;
}
