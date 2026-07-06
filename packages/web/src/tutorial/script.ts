// The onboarding tutorial's script contract (#51). The WHOLE tutorial — boards,
// fabricated ranks, scripted guesses, coach-mark sequence — is data in
// scripts/<lang>.ts. Rewriting the onboarding later means editing those files (and the
// i18n copy keys they reference): zero component changes. Per-hole outcomes of a guess
// are NEVER encoded in the steps — the Tutorial derives them from the puzzle's rank
// map at runtime, exactly like the real game, so a script edit cannot drift out of
// sync with its own ranks (scripts.test.ts guards the intended lesson arc).
//
// The tutorial runs in two STAGES:
//   1. a single-word board that teaches the embedding concept itself — the secret is
//      SHOWN (blue), a SCRAMBLE demo walks it away to its 100th neighbor (which is
//      literally where every real round starts), three gated guesses demonstrate
//      distance / MISS / improvement, then the player finds their way back;
//   2. an easy two-hole sentence played UNGUIDED, whose rank maps are stocked so the
//      obvious first guesses land on BOTH holes — multi-hole broadcast is discovered,
//      not told.

import type { Puzzle, RankMap } from '@whippin/shared';
import type { UiKey } from '../i18n';

// Where a coach panel sits. Zones, not measured elements — the panel is positioned by
// CSS per zone, which is enough to read as "about this thing".
export type Anchor = 'center' | 'hole' | 'input' | 'keyboard' | 'watermark' | 'progress';

export type TutorialStep =
  // A coach mark with copy and a NEXT button. The game is dimmed behind it.
  | { kind: 'tell'; anchor: Anchor; copyKey: UiKey }
  // The scramble demo: the stage's single hole shows its SECRET in blue; pressing
  // SCRAMBLE steps it through neighbors 1..5, then fast-rolls to the start word
  // (rank = start_rank), flashing every ladder word in between. The ladder is derived
  // from the stage's own rank map (real entries, rank <= start_rank).
  | { kind: 'scramble'; copyKey: UiKey; afterKey: UiKey }
  // A prescribed guess: input is gated to `expect` (only its letters + enter are
  // active) and the submit plays the REAL feedback choreography. `afterKey` is
  // OPTIONAL and rare — the feedback usually speaks for itself, so most guesses
  // auto-advance once it settles. {WORD} in copy renders as `expect` uppercased.
  | { kind: 'guess'; expect: string; copyKey: UiKey; afterKey?: UiKey }
  // Free typing (real vocabulary) until `target` is typed, then auto-advance —
  // solving it needs no comment. Exploration is welcome — any word gets its real
  // float (ladder rank or MISS) — but after 3 consecutive MISSes the prompt swaps
  // to `nudgeKey` ({WORD} = the target) in case they forgot.
  | { kind: 'find'; target: string; copyKey: UiKey; nudgeKey: UiKey }
  // Unguided play (real vocabulary, tries counted, progress bar live). When the
  // sentence is solved the tutorial says nothing more: the tray swaps to the score
  // ("N TRIES" — lower is better speaks for itself) + the PLAY TODAY'S PUZZLE exit.
  | { kind: 'play' };

export interface TutorialStage {
  puzzle: Puzzle; // same schema as a real puzzle (parsePuzzle-valid)
  steps: TutorialStep[];
}

export interface TutorialScript {
  stages: TutorialStage[];
}
// (The per-language script lookup lives in ./scripts/index.ts — the scripts import
// padRanks from here, so this module must not import them back.)

// Pad a secret's rank map with inert placeholder entries so N (the map size) is
// realistic and computeProgress moves like the real game — with only the scripted
// entries, s(rank) clamps to 0 for every rank > N and the progress bar would sit at 0
// until a solve. Placeholder keys contain characters fold() can never produce, so no
// typed word can ever hit one; they are schema-valid {word, rank} entries otherwise.
export function padRanks(entries: RankMap[string], upTo: number): RankMap[string] {
  const out: RankMap[string] = { ...entries };
  const used = new Set(Object.values(entries).map((e) => e.rank));
  for (let rank = 1; rank <= upTo; rank += 1) {
    if (!used.has(rank)) out[`_pad${rank}`] = { word: `_pad${rank}`, rank };
  }
  return out;
}

// A pad entry is unreachable by definition (fold can't produce its key); everything
// that reads the map as CONTENT (the scramble ladder, the tests) filters with this.
export function isPadWord(word: string): boolean {
  return /^_pad\d+$/.test(word);
}
