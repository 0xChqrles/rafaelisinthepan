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
//   THE METER     (user-decided 2026-09-16, scripted the same day) a harder sentence the BOT
//                 has already half played: one word found, the other's #301 meter nearly
//                 full from its tries (`played`, the pre-played log — tap the word to see
//                 them). The player's first close guess fills it and the first letter lands;
//                 they try one more, and the bot names the answer as if it had found it.
//                 Then PLAY: they are ready for the real game.
//
// A stage is a Puzzle (the real per-puzzle schema, parsePuzzle-valid, so it feeds the REAL
// game components) plus, per hole, the one line of copy the coach says when the player is
// stuck for long: a HINT about the word. The answer itself is read off the puzzle.
//
// Boards are REAL generated neighborhoods: #154 single-word artifacts pruned to the near
// field by web/scripts/prune-word-map.mjs — the exact invocation is recorded in each
// script's header, and scripts.test.ts fails if a board and its map ever drift.

import type { Puzzle, Word } from '@whippin/shared';
import type { UiKey } from '../i18n';

export type StageKind = 'reveal' | 'word' | 'sentence' | 'meter';

export interface LessonStage {
  kind: StageKind;
  puzzle: Puzzle;
  // The meter stage only: the BOT'S tries, already played when the stage opens — the play
  // log the board, the meters and the tries wheel replay, before the player's own guesses.
  // Chosen so one secret is found and the other's meter stands just under full.
  played?: string[];
  // The meter stage only: THE PAIR. The sentence begs for `alt` — the secret's closest word
  // (rank 1), which reads in the sentence too — and before the letter is out the two SWAP
  // ROLES on whichever the player types first: type the secret and it becomes the closest
  // word (a 1, the chip fills) while `alt` becomes the secret the bot will land; type `alt`
  // and nothing changes. Once the letter is out there is no swap. The goal is only that the
  // first letter is seen before the sentence is solved (user-decided 2026-09-16).
  pair?: { alt: Word };
  // One hint per hole, in `puzzle.holes` order — what the coach says once a hole has resisted
  // long enough (coach.ts `STUCK`), before it gives the answer.
  hints: UiKey[];
}

export interface LessonScript {
  stages: LessonStage[]; // reveal, word, sentence, meter — in the order they are played
}
// (The per-language script lookup lives in ./scripts/index.ts.)
