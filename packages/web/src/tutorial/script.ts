// The onboarding lesson's script contract (#51, re-arced by #155, remade by #269).
//
// LEVEL 1 is the game, played: a guided run in two STAGES on real boards, with the real
// keyboard and the real vocabulary from the first frame. Nothing is pressed for the player
// and nothing is typed for them — every beat is a decision they can get wrong, and the
// feedback is the teacher (user-decided 2026-09-16, after watching newcomers press what they
// were told to press and learn nothing from it).
//
//   THE REVEAL    (user-decided 2026-09-16, fifth pass: "where is the secret word? what does
//                 'mer est le plus proche' mean?") — the secret word is SHOWN, then hidden in
//                 front of the player: its closest word takes its place, wearing a 1. The
//                 player types the secret back. Nothing is explained that was not just seen.
//   THE WORD      another secret, never shown, its stand-in a dozen ranks out: a real search
//                 on one word, with the coach reacting to the guesses (coach.ts).
//   THE SENTENCE  two holes, start words in the game's own 50–150 band: one guess is tried on
//                 every hole, a tap on a word opens the tries, fewer tries is the score. One
//                 new thing at a time. Solved, the bot says this one was easy and the daily
//                 sentences are harder — and CONTINUE leads into:
//   THE METER     (user-decided 2026-09-16) a harder sentence, clues farther out, and the
//                 #301 meters SHOWN for the first time: a close guess fills the word's chip,
//                 a full chip reveals the secret's first letter. The lesson's meter fills
//                 `chargeBoost` times faster than the day's, so the reveal lands inside the
//                 run. Solved, PLAY ends the lesson.
//
// A stage is a Puzzle (the real per-puzzle schema, parsePuzzle-valid, so it feeds the REAL
// game components) plus, per hole, the one line of copy the coach says when the player is
// stuck for long: a HINT about the word. The answer itself is read off the puzzle.
//
// Boards are REAL generated neighborhoods: #154 single-word artifacts pruned to the near
// field by web/scripts/prune-word-map.mjs — the exact invocation is recorded in each
// script's header, and scripts.test.ts fails if a board and its map ever drift.

import type { Puzzle } from '@whippin/shared';
import type { UiKey } from '../i18n';

export type StageKind = 'reveal' | 'word' | 'sentence' | 'meter';

export interface LessonStage {
  kind: StageKind;
  puzzle: Puzzle;
  // The meter stage only: how many times faster than the day's rule the lesson's meters
  // fill (`game/charge.ts` is the one reading of what a guess pays; this scales its result).
  chargeBoost?: number;
  // One hint per hole, in `puzzle.holes` order — what the coach says once a hole has resisted
  // long enough (coach.ts `STUCK`), before it gives the answer.
  hints: UiKey[];
}

export interface LessonScript {
  stages: LessonStage[]; // reveal, word, sentence, meter — in the order they are played
}
// (The per-language script lookup lives in ./scripts/index.ts.)
