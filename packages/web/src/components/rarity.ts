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

// --- what a claim LOOKS like: the word is STRUCK ------------------------------------------
// A find HITS the word (decided 2026-08-09, replacing the grade name that used to stamp onto
// it). A name has to be read, and a run against a clock has no time for that; the grade is
// still written down twice anyway, in the run's history and its tally. What the strike adds
// is the moment.
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

// What a claim's strike IS: which sheet, and how many times the word is hit with it.
export type Strike = { art: StrikeArt; blows: number };

// The ladder, indexed by grade like `RARITY_COLORS` above — one table, complete by type, so
// adding or retuning a grade moves exactly one thing. It escalates in FOUR steps across the
// five grades: a cut, a cross, a burst, and the ultra star. The same escalation the seconds
// ladder makes, said in gestures rather than five sizes.
//
// **What escalates is the EVENT, not the duration.** The burst is a step up from the cross
// while spending HALF the time on screen (250ms against 500), and the ultra is a step up
// again at 350. Reading intensity off a clock would rank these backwards; the order of
// `STRIKE_ARTS` is what says which is bigger, with the blow count breaking ties inside a
// sheet.
export const STRIKES: Record<Rarity, Strike> = {
  COMMON: { art: SLASH_ART, blows: 1 },
  UNCOMMON: { art: SLASH_ART, blows: 1 },
  // Struck TWICE, the second blow mirrored so the pair crosses.
  RARE: { art: SLASH_ART, blows: 2 },
  OBSCURE: { art: BURST_ART, blows: 1 },
  ARCANE: { art: ULTRA_ART, blows: 1 },
};

export function strikeFor(rarity: Rarity): Strike {
  return STRIKES[rarity];
}

// When blow `index` of this strike lands: the moment the one before it ends, with NO pause
// between them (2026-08-09, dropping a one-frame gap). Two strokes on screen at once read as
// one thick stroke, so they still never overlap — but the daylight that says "struck twice"
// belongs to the WORD, not to the sprite: it stops reacting a frame early (below), so the
// beat is there whether or not the art pauses.
export function blowDelayMs(strike: Strike, index: number): number {
  return index * strike.art.ms;
}

// How long the WORD reacts to one blow — its recoil and the grade's colour on it. FOUR frames,
// which is one short of the shortest sheet, so the last frame of every blow lands on a word
// already back at rest (decided 2026-08-09). That is the whole beat between two hits now: the
// strokes run continuously, and what separates them is the word letting go and being struck
// again. On a longer sheet the same rule is what makes the extra frames read as DISSIPATION.
// Stated in the ART's own frames rather than as a duration, because it is a claim about which
// frames of the hit the word is answering.
export const STRUCK_FRAMES = 4;
export const STRUCK_MS = STRUCK_FRAMES * SLASH_FRAME_MS;

// How long a strike is on screen, so the screen can hold its ending beat for one.
export function strikeDurationMs(strike: Strike): number {
  return strike.blows * strike.art.ms;
}
