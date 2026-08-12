import type { Rarity } from '../game/wordGame';

// How a rarity grade LOOKS and how hard it lands (#163). The ladder itself — the names,
// the corpus fractions, the seconds — is the game's rule and lives in `game/wordGame.ts`;
// this is the presentation of it, and nothing here restates a rule: every table below is
// keyed by the GRADE (`Record<Rarity, …>`, complete by type), so adding or retuning a
// grade moves exactly one table and the compiler finds every hole.

// --- the colours -----------------------------------------------------------------------
// COPIED from the app's existing palettes, never invented: take stops the app already uses
// and pin each hex to its source so nothing drifts silently (`rarity.test.ts`).
//
// FOUR constraints, all MEASURED in CIE76 dE rather than eyeballed:
//
//   - RED IS RESERVED FOR MISS. Every grade clears 37+ dE from `--danger`; ARCANE's pink is
//     the closest at 37.75, and the two can never co-occur — a guess is a claim or a miss,
//     never both.
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

// A grade also has a TEXT-medium presentation — its share-text bead — and that one lives
// with the share composition it belongs to (`game/share.ts` `RARITY_EMOJI`/`rarityRow`),
// beside the sentence emoji row it is the analogue of, not here.

// --- what a claim LOOKS like: the word is STRUCK ------------------------------------------
// A find HITS the word (decided 2026-08-09, replacing the grade name that used to stamp onto
// it). A name has to be read, and a run against a clock has no time for that — so nothing
// here PARKS: the hit's colour carries the grade, the word takes it under the strike, and
// the grade's name + the guess's rank fly off the word as the hit's LOOT (`WordLoot`,
// 2026-08-10), gone within the second. What the strike adds is the moment.
//
// THREE SHEETS, in `assets/hits/`, all walked at ONE frame rate. Two of them are pure white
// and drawn as a MASK painted in the grade's colour — the header globe's technique, and the
// reason one sheet serves several grades; the third is authored IN COLOUR and is drawn as an
// IMAGE (see `.word-slash.ultra` in index.css, where the per-sheet geometry lives, each
// number measured off its own art rather than picked).
export const SLASH_FRAME_MS = 50;

export type StrikeArt = {
  /** Modifier class on `.word-slash`; the base class IS the stroke, so it needs none. */
  css: string;
  frames: number;
  /** One blow's length. Every sheet runs at `SLASH_FRAME_MS`, so this is never independent. */
  ms: number;
};

const art = (css: string, frames: number): StrikeArt => ({
  css,
  frames,
  ms: frames * SLASH_FRAME_MS,
});

// A diagonal stroke that lands and dissipates. The default hit.
export const SLASH_ART = art('', 5);
// A wider, taller detonation — same white, same mask, so it also wears the grade's colour.
export const BURST_ART = art('burst', 5);
// The one coloured sheet: a violet-and-cyan star that scatters into shards.
export const ULTRA_ART = art('ultra', 7);

// Commonest first: THIS ORDER IS THE ESCALATION, and `rarity.test.ts` reads it as one.
export const STRIKE_ARTS: readonly StrikeArt[] = [SLASH_ART, BURST_ART, ULTRA_ART];

// The ladder, indexed by grade like `RARITY_COLORS` above — one table, complete by type, so
// adding or retuning a grade moves exactly one thing. It escalates in THREE gestures across
// the five grades: a cut, a burst, and the ultra star (user-decided 2026-08-11, retiring the
// RARE cross and the whole multi-blow machinery with it — a strike is ONE blow of one sheet
// now, and `blows`/`blowDelayMs` are gone). The same escalation the seconds ladder makes,
// said in gestures rather than five sizes.
//
// **What escalates is the EVENT, not the duration.** The burst is a step up from the cut and
// the ultra a step up again. Reading intensity off a clock would rank these backwards; the
// order of `STRIKE_ARTS` is what says which is bigger.
export const STRIKES: Record<Rarity, StrikeArt> = {
  COMMON: SLASH_ART,
  UNCOMMON: SLASH_ART,
  RARE: SLASH_ART,
  OBSCURE: BURST_ART,
  ARCANE: ULTRA_ART,
};

export function strikeFor(rarity: Rarity): StrikeArt {
  return STRIKES[rarity];
}

// How long the WORD reacts to the blow — its recoil and the grade's colour on it. FOUR
// frames, which is one short of the shortest sheet, so the last frame of the blow lands on a
// word already back at rest (decided 2026-08-09): on a longer sheet the same rule is what
// makes the extra frames read as DISSIPATION. Stated in the ART's own frames rather than as
// a duration, because it is a claim about which frames of the hit the word is answering.
export const STRUCK_FRAMES = 4;
export const STRUCK_MS = STRUCK_FRAMES * SLASH_FRAME_MS;
