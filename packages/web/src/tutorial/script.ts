// The onboarding tutorial's script contract (#51). The WHOLE tutorial — dummy
// sentence, fabricated ranks, scripted guesses, coach-mark sequence — is data in
// scripts/<lang>.ts. Rewriting the onboarding later means editing those files (and the
// i18n copy keys they reference): zero component changes. Per-hole outcomes of a guess
// are NEVER encoded in the steps — the Tutorial derives them from the puzzle's rank
// map at runtime, exactly like the real game, so a script edit cannot drift out of
// sync with its own ranks (scripts.test.ts guards the intended lesson sequence).

import type { Puzzle, RankMap } from '@whippin/shared';
import type { UiKey } from '../i18n';

// Where a coach mark sits. Zones, not measured elements — the panel is positioned by
// CSS per zone (.coach--<anchor>), which is enough to read as "about this thing".
export type Anchor = 'center' | 'hole' | 'input' | 'keyboard' | 'watermark' | 'progress';

export type TutorialStep =
  // A coach mark with copy and a NEXT button. The game is dimmed behind it.
  | { kind: 'tell'; anchor: Anchor; copyKey: UiKey }
  // A playable beat: input is gated to `expect` (only its letters + enter are active),
  // the submit plays the REAL feedback choreography, then `afterKey` explains what
  // just happened (with NEXT). {WORD} in the copy renders as `expect` uppercased.
  | { kind: 'guess'; expect: string; copyKey: UiKey; afterKey: UiKey };

export interface TutorialScript {
  puzzle: Puzzle; // same schema as a real puzzle (parsePuzzle-valid), 2 holes
  steps: TutorialStep[];
}
// (The per-language script lookup lives in ./scripts/index.ts — the scripts import
// padRanks from here, so this module must not import them back.)

// Pad a secret's rank map with inert placeholder entries so N (the map size) is
// realistic and computeProgress moves like the real game — with only the 3-4 scripted
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
