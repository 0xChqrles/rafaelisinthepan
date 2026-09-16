// THE COACH IS REACTIVE (#269, user-decided 2026-09-16): it speaks on a mistake or a stall,
// never on success. A number that falls when the player gets warmer teaches "smaller is
// closer" better than a sentence saying so — but only if the player chose the word — so the
// coach's job is to say the one thing the last guess calls for, and otherwise nothing. A
// player who plays well reads almost nothing, which is the point.
//
// This module is the whole rule, pure: the board's state in, the line to say out. The
// component renders it; coach.test.ts replays guess sequences against it.
import type { RankEntry, RuntimeHole } from '@whippin/shared';
import { t } from '../i18n';
import type { LessonStage } from './script';

export type Stage = 'word' | 'sentence';

// One counted guess as the board saw it: what each hole made of it (its rank entry, or
// undefined for a MISS — a hole already found reads undefined too, it takes no guesses) and
// whether it moved the hole closer.
export interface GuessEvent {
  typed: string;
  entries: (RankEntry | undefined)[];
  improved: boolean[];
}

export interface CoachState {
  stage: Stage;
  holes: RuntimeHole[]; // as they stand now
  events: GuessEvent[]; // counted guesses, in order
  tapped: boolean; // the player has opened a word's tries at least once
}

export type CoachLine =
  // Before the first guess of the word stage: the goal, in one line.
  | { kind: 'intro' }
  // The first guess that ranks but does not move the hole: what the number IS, against the
  // number the hole already shows.
  | { kind: 'away'; guess: RankEntry; hole: RuntimeHole }
  // The first MISS: too far to count.
  | { kind: 'miss'; typed: string }
  // A hole has resisted STUCK[0] guesses: look near the word it shows.
  | { kind: 'near'; hole: RuntimeHole }
  // …STUCK[1] guesses: the board's own hint about that word.
  | { kind: 'hint'; holeIndex: number }
  // …STUCK[2] guesses: the answer.
  | { kind: 'answer'; holeIndex: number }
  // The sentence's one mechanic worth a line, said once the player has tries to look at.
  | { kind: 'tap' };

// Guesses a hole may resist before each rung of the ladder. The sentence gets more room:
// two holes are in play, and a guess that moves one is progress the other cannot show.
export const STUCK: Record<Stage, readonly [number, number, number]> = {
  word: [3, 6, 9],
  sentence: [4, 8, 12],
};
// Counted guesses on the sentence before the tap is taught — never before there are tries
// worth seeing.
export const TAP_AFTER = 3;

// For each hole still open, how many guesses it has resisted since it last moved (or since
// the start).
function stuckPerHole({ holes, events }: CoachState): (number | null)[] {
  return holes.map((hole, i) => {
    if (hole.rank === 0) return null;
    let since = 0;
    for (let k = events.length - 1; k >= 0; k -= 1) {
      if (events[k].improved[i]) break;
      since += 1;
    }
    return since;
  });
}

export function coachLine(state: CoachState): CoachLine | null {
  const { stage, holes, events, tapped } = state;
  const [near, hint, answer] = STUCK[stage];

  // The ladder first: the hole that has resisted longest sets the rung.
  const stuck = stuckPerHole(state);
  let target = -1;
  for (let i = 0; i < stuck.length; i += 1) {
    const s = stuck[i];
    if (s !== null && (target < 0 || s > (stuck[target] as number))) target = i;
  }
  const worst = target < 0 ? 0 : (stuck[target] as number);
  if (worst >= answer) return { kind: 'answer', holeIndex: target };
  if (worst >= hint) return { kind: 'hint', holeIndex: target };

  // The sentence teaches the tap once there is something to see, and stops once it is seen.
  if (stage === 'sentence' && !tapped && events.length >= TAP_AFTER) return { kind: 'tap' };

  if (worst >= near) return { kind: 'near', hole: holes[target] };

  if (stage === 'word') {
    if (events.length === 0) return { kind: 'intro' };
    const last = events[events.length - 1];
    const entry = last.entries[0];
    if (entry && !last.improved[0]) {
      // The first ranked guess that changed nothing: say what the number means, once.
      const first = events.findIndex((e) => e.entries[0] && !e.improved[0]);
      if (first === events.length - 1) return { kind: 'away', guess: entry, hole: holes[0] };
    } else if (!entry) {
      const first = events.findIndex((e) => !e.entries[0]);
      if (first === events.length - 1) return { kind: 'miss', typed: last.typed };
    }
  }
  return null;
}

// The line as the coach box prints it: the copy key's text with the board's words in their
// in-game dress (CoachText's [[..]] markup — the held word's chip and exponent, MISS red,
// the secret's cobalt).
export function coachCopy(
  lang: string,
  line: CoachLine,
  stage: LessonStage,
  coarsePointer: boolean,
): string {
  const chip = (word: string, rank: number) => `[[w:${word}^${rank}]]`;
  switch (line.kind) {
    case 'intro':
      return t(lang, 'tutIntro');
    case 'away':
      return t(lang, 'tutAway')
        .replace('{guess}', chip(line.guess.word, line.guess.rank))
        .replace('{n}', String(line.guess.rank))
        .replace('{start}', chip(line.hole.word, line.hole.rank))
        .replace('{m}', String(line.hole.rank));
    case 'miss':
      return t(lang, 'tutMiss').replace('{miss}', `[[m:${line.typed}]]`);
    case 'near':
      return t(lang, 'tutNear').replace('{word}', chip(line.hole.word, line.hole.rank));
    case 'hint':
      return t(lang, stage.hints[line.holeIndex]);
    case 'answer':
      return t(lang, 'tutAnswer').replace(
        '{answer}',
        `[[b:${stage.puzzle.holes[line.holeIndex].secret.word}]]`,
      );
    case 'tap':
      return t(lang, coarsePointer ? 'tutTap' : 'tutClick');
  }
}
