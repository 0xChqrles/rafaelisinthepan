// The onboarding tutorial's script contract (#51, re-arced by #155; ending re-arced again
// 2026-08-11 — the CORE CONCEPTS arc). The WHOLE tutorial — the board, the scripted guesses,
// the coach-mark sequence — is data in scripts/<lang>.ts. Rewriting the onboarding later
// means editing those files (and the i18n copy keys they reference): zero component changes.
// Per-step outcomes of a guess are NEVER encoded in the steps — the Tutorial derives them
// from the board's rank map at runtime, exactly like the real game, so a script edit cannot
// drift out of sync with its own ranks (scripts.test.ts guards the intended lesson arc).
//
// ONE board, one arc: a single word and its REAL neighborhood — the mix demo walks the
// secret out to the start word, three gated guesses demonstrate distance / MISS /
// improvement, the player finds their way back, and the ending states the game's OTHER core
// concept: word RARITY, the five-grade ladder every mode speaks. The tutorial teaches the
// concepts the modes share (semantic distance, rarity) and NOTHING mode-specific — each
// mode's own rules live on that mode's pre-game gate (Word mode's gate screen, the sentence
// game's one-time PLAY gate).
//
// The board's ranks are a REAL generated neighborhood (a #154 single-word artifact, pruned —
// see scripts/<lang>.ts): the mix ladder and the free find play against real ranks.

import type { Puzzle } from '@whippin/shared';
import type { UiKey } from '../i18n';

// The screen is split in two: EXPLANATIONS live in the top box (typewritten, with in-game
// word styling — see CoachText's [[..]] markup in the copy), INTERACTIONS live at the bottom
// (the mix button, then the keyboard, then PLAY). No modals, no NEXT, no SKIP — the flow
// advances by playing.

// One stop of the mix demo: pressing the button (labelled `labelKey`) animates the word to
// `rank` — a single shake+swap for the first stop, a fast roll through every ladder word for
// the others — then `copyKey` (if any) becomes the explanation.
interface MixStop {
  rank: number;
  labelKey: UiKey;
  copyKey?: UiKey;
}

export type TutorialStep =
  // The mix demo: the board's single hole shows its SECRET in blue; each press walks it
  // further out (stops, e.g. 1 -> 10 -> 100), teaching the neighbor ladder. The last stop
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
  // The ending (2026-08-11, superseding the #155 themes tap): the game's SECOND core
  // concept, word RARITY. Two beats, one idea each — the tutorial's own grammar:
  // `introCopyKey` states the CLAIM (every word has a rarity) over the found word, and the
  // tray's NEXT advances it; then the word gives way to the RARITY LADDER — the five grade
  // names in their own colours, commonest first (RarityLadder) — while `ladderCopyKey`
  // states what the ladder means. The tray then offers PLAY,
  // which ends the tutorial. There is no graduation screen, because there is no score to
  // show. What a grade PAYS is deliberately not here: that is Word mode's rule, and it
  // lives on Word mode's own gate.
  | { kind: 'rarity'; introCopyKey: UiKey; ladderCopyKey: UiKey };

export interface TutorialScript {
  puzzle: Puzzle; // same schema as a real puzzle (parsePuzzle-valid)
  steps: TutorialStep[];
}
// (The per-language script lookup lives in ./scripts/index.ts.)
