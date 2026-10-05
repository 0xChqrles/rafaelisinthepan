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
//                 them). The player's first close guess fills it and the hole ACTIVATES —
//                 one masked word, at half the hole's best, joins the tries (user-decided
//                 2026-09-22, replacing the first letter; the half 2026-10-06); they reveal
//                 it for a try and half the meter, then find the secret, a failed try
//                 earning the hint.
//                 Then PLAY: they are ready for the real game.
//
// A stage is a Puzzle (the real per-puzzle schema, parsePuzzle-valid, so it feeds the REAL
// game components) plus, per hole, the one line of copy the coach says when the player is
// stuck for long: a HINT about the word. The answer itself is read off the puzzle.
//
// Boards are REAL generated neighborhoods: #154 single-word artifacts pruned to the near
// field by web/scripts/prune-word-map.mjs — the exact invocation is recorded in each
// script's header, and scripts.test.ts fails if a board and its map ever drift.

import type { Puzzle, RankEntry, Word } from '@whippin/shared';
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
  // (rank 1 in the map, read 2 by the lesson: `meterView`), which reads in the sentence too
  // — and before the hole is active a word typed that reads CLOSER than `alt` TRADES
  // PLACES with it: type the secret and it reads 2 (the chip fills) while `alt` becomes the
  // secret the player then finds; type the word read 1 and it reads 2 while `alt` becomes
  // the one word left to reveal; type `alt` and nothing changes. Once the hole is active
  // there is no trade. The goal is that the activation — with a word to reveal — is seen
  // before the sentence is solved (user-decided 2026-09-16).
  pair?: { alt: Word; hint: UiKey }; // `hint`: the coach's hint once `alt` is the secret
  // One hint per hole, in `puzzle.holes` order — what the coach says once a hole has resisted
  // long enough (coach.ts `STUCK`), before it gives the answer.
  hints: UiKey[];
}

export interface LessonScript {
  stages: LessonStage[]; // reveal, word, sentence, meter — in the order they are played
}

// Two ranks TRADE PLACES in a map's reading: every entry at rank `a` reads `b`, at the
// distance `b`'s group stood (`dq`; none at rank 0), and every entry at `b` reads `a`.
function trade(map: Record<string, RankEntry>, a: number, b: number): Record<string, RankEntry> {
  const dqOf = (rank: number) => (rank === 0 ? undefined : Object.values(map).find((e) => e.rank === rank)?.dq);
  const [dqA, dqB] = [dqOf(a), dqOf(b)];
  const reads = (word: string, rank: number, dq: number | undefined) =>
    (dq === undefined ? { word, rank } : { word, rank, dq }) as RankEntry;
  const view: Record<string, RankEntry> = {};
  for (const [key, entry] of Object.entries(map)) {
    if (entry.rank === a) view[key] = reads(entry.word, b, dqB);
    else if (entry.rank === b) view[key] = reads(entry.word, a, dqA);
    else view[key] = entry;
  }
  return view;
}

// THE PAIR TRADE: which word, typed before the hole is active, read closer than `alt` and
// took its place — the secret (0), the word read 1 (1), or none yet (null).
export type MeterTrade = 0 | 1 | null;

// THE METER STAGE'S READING of the open secret's map (`pair.alt` is its rank-1 word):
//   - the LESSON VIEW: `alt` reads 2 and the rank-2 word reads 1 — so once the obvious word
//     fills the meter, ONE word is left closer than it, and the reveal hands it over (the
//     game offers the word at half the best — from 2, the word read 1 — never the secret);
//   - TRADED (`traded`, a word read closer than `alt` typed before the hole is active): on
//     top of that, that word and `alt` trade places — it reads 2 and fills the meter. The
//     secret traded, `alt` becomes the secret the player then finds; the word read 1
//     traded, `alt` reads 1 and is the word the reveal hands over. A full meter therefore
//     always holds a best of 2 or more: there is always a word to reveal.
// Everything farther is untouched.
export function meterView(map: Record<string, RankEntry>, traded: MeterTrade): Record<string, RankEntry> {
  const view = trade(map, 1, 2);
  return traded === null ? view : trade(view, traded, 2);
}

// Whether a word typed before the hole is active, read through the lesson view at `rank`,
// trades places with `alt`: the secret, or the word read 1 — anything closer than `alt`.
export function tradeFor(rank: number | undefined): MeterTrade {
  return rank === 0 || rank === 1 ? rank : null;
}
// (The per-language script lookup lives in ./scripts/index.ts.)
