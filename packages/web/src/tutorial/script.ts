// The onboarding tutorial's script contract (#51, re-arced by #155). The WHOLE tutorial —
// the board, the scripted guesses, the coach-mark sequence — is data in scripts/<lang>.ts.
// Rewriting the onboarding later means editing those files (and the i18n copy keys they
// reference): zero component changes. Per-step outcomes of a guess are NEVER encoded in the
// steps — the Tutorial derives them from the board's rank map at runtime, exactly like the
// real game, so a script edit cannot drift out of sync with its own ranks (scripts.test.ts
// guards the intended lesson arc).
//
// ONE board, one arc (#155, superseding the two-stage version): a single word and its REAL
// neighborhood — the mix demo walks the secret out to the start word, three gated guesses
// demonstrate distance / MISS / improvement, the player finds their way back, and then taps
// the word they found — its route line then takes its place. The unguided bakery sentence
// that used to follow is gone: analytics said it was widely skipped, its one lesson (a guess
// filling several holes) is discoverable in play, and the ending it freed is the only place
// the game teaches ROUTES.
//
// The board's ranks are a REAL generated neighborhood (a #154 single-word artifact, pruned —
// see scripts/<lang>.ts). They have to be: the route line only draws where #115's geometry
// exists, and the hand-authored map this used to carry had no `dq` at all.

import type { Puzzle } from '@whippin/shared';
import type { UiKey } from '../i18n';

// The screen is split in two: EXPLANATIONS live in the top box (typewritten, with in-game
// word styling — see CoachText's [[..]] markup in the copy), INTERACTIONS live at the bottom
// (the mix button, then the keyboard, then PLAY). No modals, no NEXT, no SKIP — the flow
// advances by playing.

// One stop of the mix demo: pressing the button (labelled `labelKey`) animates the word to
// `rank` — a single shake+swap for the first stop, a fast roll through every ladder word for
// the others — then `copyKey` (if any) becomes the explanation.
export interface MixStop {
  rank: number;
  labelKey: UiKey;
  copyKey?: UiKey;
}

export type TutorialStep =
  // The mix demo: the board's single hole shows its SECRET in blue; each press walks it
  // further out (stops, e.g. -1 -> -10 -> -100), teaching the neighbor ladder. The last stop
  // must land on the start word (rank = start_rank) — the demo IS the explanation of where
  // start words come from. The ladder is derived from the board's own rank map (one entry per
  // group, rank <= start_rank). After the last stop the button gives way to the keyboard and
  // the next step's prompt.
  | { kind: 'mix'; copyKey: UiKey; stops: MixStop[] }
  // A prescribed guess: input is gated to `expect` (only its letters + enter are active), the
  // submit plays the REAL feedback choreography, then the flow rolls to the next prompt — the
  // feedback speaks for itself, no explanations after.
  | { kind: 'guess'; expect: string; copyKey: UiKey }
  // Free typing (real vocabulary) until `target` is typed, then auto-advance — solving it
  // needs no comment. Exploration is welcome — any word gets its real float (a rank from the
  // board's map, or MISS) — but after 3 consecutive MISSes the prompt swaps to `nudgeKey` in
  // case they forgot the word.
  | { kind: 'find'; target: string; copyKey: UiKey; nudgeKey: UiKey }
  // The ending (#155). The word the player just found is now TAPPABLE — the same button and
  // the same ambient wave as a real round — and the coach nudges the tap in the input
  // device's own verb (`tapCopyKey` on a coarse pointer, `clickCopyKey` otherwise). The tap
  // REPLACES the word with its THEMES, shown as clouds of words ONE AT A TIME (findings
  // 2026-08-04 — first the route line, then one road at a time, finally clouds: the line
  // was too much information at once, and a cloud of themed words with their exponents says
  // "these belong together, this close" with nothing to decode): stage k is theme k's cloud
  // alone, in that route's color, with `themeCopyKeys[k]` naming it; each NEXT THEME press
  // swaps to the next cloud. `themeCopyKeys` is ordered by the map's road ids — road 0
  // holds rank 1 — and must name every road the board's map actually ships
  // (scripts.test.ts). After the last theme the close shows the ROUTES TEASER — the themes'
  // colored lines with scroll chevrons and a couple of each theme's words riding them as
  // stations, a glimpse of the map every word offers — `closeCopyKey` states the general
  // principle, and the tray offers PLAY,
  // which ends the tutorial. There is no graduation screen, because there is no score to
  // show.
  | { kind: 'tap'; tapCopyKey: UiKey; clickCopyKey: UiKey; themeCopyKeys: UiKey[]; closeCopyKey: UiKey };

export interface TutorialScript {
  puzzle: Puzzle; // same schema as a real puzzle (parsePuzzle-valid)
  steps: TutorialStep[];
}
// (The per-language script lookup lives in ./scripts/index.ts.)
