// THE STRIKE ART (#163/#301): three sprite sheets in `assets/hits/`, all walked at ONE frame
// rate, that a game word can be HIT with. The sentence game cuts a hole with the slash on a
// charging guess, bursts its meter at 100 and stars the exact hit (#301). What lives here is
// the ART and its animation contract — which sheet, how many frames, how long a blow is —
// and nothing about what a hit MEANS on the board.
//
// Two of the sheets are pure white and drawn as a MASK painted in the strike's colour — the
// header globe's technique, and the reason one sheet serves several colours; the third is
// authored IN COLOUR and is drawn as an IMAGE (see `.strike.ultra` in index.css, where the
// per-sheet geometry lives, each number measured off its own art rather than picked).
const SLASH_FRAME_MS = 50;

export type StrikeArt = {
  /** Modifier class on `.strike`; the base class IS the stroke, so it needs none. */
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
// A wider, taller detonation — same white, same mask, so it also wears the strike's colour.
export const BURST_ART = art('burst', 5);
// The one coloured sheet: a violet-and-cyan star that scatters into shards.
export const ULTRA_ART = art('ultra', 7);

// How long the WORD reacts to the blow — its recoil and the chip's inversion. FOUR frames,
// which is one short of the
// shortest sheet, so the last frame of the blow lands on a word already back at rest
// (decided 2026-08-09): on a longer sheet the same rule is what makes the extra frames read
// as DISSIPATION. Stated in the ART's own frames rather than as a duration, because it is a
// claim about which frames of the hit the word is answering.
const STRUCK_FRAMES = 4;
export const STRUCK_MS = STRUCK_FRAMES * SLASH_FRAME_MS;
