import type { Rarity } from '../game/wordGame';

// How a rarity grade LOOKS and how hard it lands (#163). The ladder itself — the names,
// the corpus fractions, the seconds — is the game's rule and lives in `game/wordGame.ts`;
// this is the presentation of it, and nothing here restates a rule: every table below is
// keyed by the GRADE (`Record<Rarity, …>`, complete by type), so adding or retuning a
// grade moves exactly one table and the compiler finds every hole.

// --- the colours -----------------------------------------------------------------------
// THE INK LADDER (authored 2026-08-17 with the stamp-ink retune — the first calm cut
// went dusty and read "almost creepy"): five printed-ink tones keeping the electric
// set's hue walk (neutral → green → cyan → violet → pink) so a returning player's ladder
// intuition survives, at riso saturations that sit in the ink world without going neon.
//
// Constraints RE-MEASURED for this set (`rarity.test.ts` pins the minimums):
//
//   - THE MISS COLOUR IS NO GRADE'S: MISS is the gradient's weird-terminus RED
//     (`MISS_COLOR`, @whippin/shared — back to red when the scale grew past the yellow),
//     and every grade clears 34+ dE from it.
//   - `--solve` is THE DAY'S WORD, the very thing the label floats on top of: every
//     grade clears 25+ (OBSCURE's violet the closest at 26.8).
//   - the timer's `--danger` red: every grade clears 30+ (ARCANE the closest at 37).
//   - LEGIBILITY on `--bg`: every grade ≥4.9:1 (OBSCURE was walked up from a 3.5:1
//     deep violet — the same trap the electric set documented).
export const RARITY_COLORS: Record<Rarity, string> = {
  // --muted itself: the quiet voice, "no grade awarded", which is what COMMON means.
  COMMON: '#b0aca4',
  // mint-green ink — the first chromatic step off the grey.
  UNCOMMON: '#4ed48d',
  // sky-cyan ink — the blue family, held clear of the cobalt the label floats over.
  RARE: '#3fc6e8',
  // violet ink — deep and hidden, pushed magenta-ward to clear both the cobalt day word
  // and the gradient's rose-orchid middle.
  OBSCURE: '#b164f2',
  // magenta ink — the loudest tone on the ladder.
  ARCANE: '#f04ea6',
};

// MISS's red lives with the ramp (`MISS_COLOR` in @whippin/shared's heat.ts), because it
// is exactly the weird terminus: `heatColor(0) === MISS_COLOR`. What stays HERE is the
// reservation the grades owe it — no grade may near the MISS colour (`rarity.test.ts`).

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
const BURST_ART = art('burst', 5);
// The one coloured sheet: a violet-and-cyan star that scatters into shards.
const ULTRA_ART = art('ultra', 7);

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
const STRUCK_FRAMES = 4;
export const STRUCK_MS = STRUCK_FRAMES * SLASH_FRAME_MS;
