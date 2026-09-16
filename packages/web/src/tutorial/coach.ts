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
import type { LessonStage, StageKind } from './script';
import { initialOf } from '../game/charge';

export type Stage = StageKind;

// One counted guess as the board saw it: what each hole made of it (its rank entry, or
// undefined for a MISS — a hole already found reads undefined too, it takes no guesses) and
// whether it moved the hole closer.
export interface GuessEvent {
  typed: string;
  entries: (RankEntry | undefined)[];
  improved: boolean[];
  // The meter stage: this guess added charge to some hole, and the hole whose meter it
  // FILLED (its initial is out), if any.
  charged?: boolean;
  filled?: number | null;
}

export interface CoachState {
  stage: Stage;
  holes: RuntimeHole[]; // as they stand now
  events: GuessEvent[]; // counted guesses, in order
  tapped: boolean; // the player has opened a word's tries at least once
  revealed: boolean; // the reveal stage's secret is still on screen (nothing to guess yet)
  finished: boolean; // every hole reads 0 — the stage is over
}

export type CoachLine =
  // The reveal: the secret word, shown; then, hidden, what took its place.
  | { kind: 'reveal'; holeIndex: number }
  | { kind: 'hidden'; hole: RuntimeHole }
  // Before the first guess: the goal in one line — on the word, naming the clue the hole
  // shows; on the sentence, that there are two of them now.
  | { kind: 'intro'; hole: RuntimeHole }
  | { kind: 'introSentence' }
  | { kind: 'introMeter' }
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
  // The sentence's one mechanic worth a line, said from the first guess that lands a number
  // (there is a try to look at), until it is done.
  | { kind: 'tap' }
  // The sentence solved: the tries it took — the score, said once.
  | { kind: 'solved'; tries: number }
  // The meter stage: the first guess that filled a chip a little; a chip filled to the top,
  // and the letter it revealed; the run's end.
  | { kind: 'charged' }
  | { kind: 'letter'; holeIndex: number }
  | { kind: 'done'; tries: number };

// Guesses a hole may resist before each rung of the ladder. The sentence gets more room:
// two holes are in play, and a guess that moves one is progress the other cannot show.
export const STUCK: Record<Stage, readonly [number, number, number]> = {
  reveal: [2, 4, 6], // the answer was just on screen: nudge early
  word: [3, 6, 9],
  sentence: [4, 8, 12],
  meter: [6, 10, 14], // a stall here fills the meter: give it room to pay off
};

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
  const { stage, holes, events, tapped, revealed, finished } = state;
  if (stage === 'reveal' && revealed) return { kind: 'reveal', holeIndex: 0 };
  // The end: a sentence's tries are its score, said once; a found word needs no comment.
  if (finished) {
    if (stage === 'sentence') return { kind: 'solved', tries: events.length };
    if (stage === 'meter') return { kind: 'done', tries: events.length };
    return null;
  }
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

  // The sentence teaches the tap from the first guess that landed a number — there is a try
  // to look at — and stops once it is seen.
  const landed = events.some((e) => e.entries.some((entry) => entry !== undefined));
  if (stage === 'sentence' && !tapped && landed) return { kind: 'tap' };

  if (worst >= near) return { kind: 'near', hole: holes[target] };

  if (events.length === 0) {
    if (stage === 'reveal') return { kind: 'hidden', hole: holes[0] };
    if (stage === 'word') return { kind: 'intro', hole: holes[0] };
    return stage === 'meter' ? { kind: 'introMeter' } : { kind: 'introSentence' };
  }
  if (stage === 'meter') {
    // The chip that just filled to the top names its letter; the first chip to fill a little
    // says what filling is. Both from what the last guess did — never ahead of it.
    const last = events[events.length - 1];
    if (last.filled != null) return { kind: 'letter', holeIndex: last.filled };
    if (last.charged && events.findIndex((e) => e.charged) === events.length - 1) return { kind: 'charged' };
    return null;
  }
  if (stage === 'reveal' || stage === 'word') {
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

// "3rd", "45th" / « 7e », « 1er » — the coach counts closeness in ordinals, which need no
// concept to be understood.
export function ordinal(lang: string, n: number): string {
  if (lang === 'fr') return n === 1 ? '1er' : `${n}e`;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
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
    case 'reveal':
      return t(lang, 'tutReveal').replace(
        '{answer}',
        `[[b:${stage.puzzle.holes[line.holeIndex].secret.word}]]`,
      );
    case 'hidden':
      return t(lang, 'tutHidden').replace('{start}', chip(line.hole.word, line.hole.rank));
    case 'intro':
      return t(lang, 'tutIntro')
        .replace('{start}', chip(line.hole.word, line.hole.rank))
        .replace('{m}', ordinal(lang, line.hole.rank));
    case 'introSentence':
      return t(lang, 'tutSentenceIntro');
    case 'introMeter':
      return t(lang, 'tutMeterIntro');
    case 'charged':
      return t(lang, 'tutCharged');
    case 'letter':
      return t(lang, 'tutLetter').replace(
        '{letter}',
        `[[b:${initialOf(stage.puzzle.holes[line.holeIndex].secret.word)}]]`,
      );
    case 'done':
      return t(lang, 'tutMeterSolved').replace('{n}', String(line.tries));
    case 'away':
      return t(lang, 'tutAway')
        .replace('{guess}', chip(line.guess.word, line.guess.rank))
        .replace('{n}', ordinal(lang, line.guess.rank))
        .replace('{start}', chip(line.hole.word, line.hole.rank))
        .replace('{m}', ordinal(lang, line.hole.rank));
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
    case 'solved':
      return t(lang, 'tutSolved').replace('{n}', String(line.tries));
  }
}
