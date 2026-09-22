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
import { GIVEN } from '../game/charge';

export type Stage = StageKind;

// One counted guess as the board saw it: what each hole made of it (its rank entry, or
// undefined for a MISS — a hole already found reads undefined too, it takes no guesses) and
// whether it moved the hole closer.
export interface GuessEvent {
  typed: string;
  entries: (RankEntry | undefined)[];
  improved: boolean[];
  holeRanks: number[]; // each hole's rank BEFORE this guess landed
  // The meter stage: this guess added charge to some hole, and the hole whose meter it
  // FILLED (the hole is active, its given words out), if any.
  charged?: boolean;
  filled?: number | null;
}

export interface CoachState {
  stage: Stage;
  holes: RuntimeHole[]; // as they stand now
  events: GuessEvent[]; // counted guesses, in order
  tapped: boolean; // the player has opened a word's tries at least once (and closed them)
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
  // The meter stage's opening: the bot has played, tap the open word to see its tries — and
  // once tapped, what those tries did to the chip.
  | { kind: 'introMeter'; hole: RuntimeHole }
  | { kind: 'meterTapped' }
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
  // The sentence solved: the tries it took — the score, said once.
  | { kind: 'solved'; tries: number }
  // The meter stage: a chip filled to the top and the words it gave — tap the word to read
  // them; the end, found.
  | { kind: 'activated'; hole: RuntimeHole }
  | { kind: 'found' };

// Guesses a hole may resist before each rung of the ladder. The sentence gets more room:
// two holes are in play, and a guess that moves one is progress the other cannot show.
export const STUCK: Record<Stage, readonly [number, number, number]> = {
  reveal: [2, 4, 6], // the answer was just on screen: nudge early
  word: [2, 2, 9], // two misses in a row earn the (really easy) hint outright — user-decided 2026-09-16
  sentence: [4, 8, 12],
  meter: [1, Infinity, Infinity], // its own script below: the bot names the answer itself
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
  const open = holes.findIndex((h) => h.rank !== 0);
  // THE METER STAGE IS SCRIPTED (user-decided 2026-09-16): the bot has half played it.
  if (stage === 'meter') {
    if (finished) return { kind: 'found' };
    if (events.length === 0) return tapped ? { kind: 'meterTapped' } : { kind: 'introMeter', hole: holes[open] };
    // The hole is active: the player's turn — and a failed try after it earns the HINT, never
    // the word (user-decided 2026-09-16).
    const filledAt = events.findIndex((e) => e.filled != null);
    if (filledAt >= 0) {
      const holeIndex = events[filledAt].filled as number;
      return filledAt === events.length - 1 ? { kind: 'activated', hole: holes[holeIndex] } : { kind: 'hint', holeIndex };
    }
    // Not full yet: look near the word it shows.
    return { kind: 'near', hole: holes[open] };
  }
  // The end: a sentence's tries are its score, said once; a found word needs no comment.
  if (finished) return stage === 'sentence' ? { kind: 'solved', tries: events.length } : null;
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

  if (worst >= near) return { kind: 'near', hole: holes[target] };

  if (events.length === 0) {
    if (stage === 'reveal') return { kind: 'hidden', hole: holes[0] };
    return stage === 'word' ? { kind: 'intro', hole: holes[0] } : { kind: 'introSentence' };
  }
  if (stage === 'reveal' || stage === 'word') {
    const last = events[events.length - 1];
    const entry = last.entries[0];
    // Typing the very word the hole shows ranks where it stands — nothing to compare. Judged
    // against the hole AS IT STOOD when the guess landed.
    const farther = (e: GuessEvent) => e.entries[0] !== undefined && (e.entries[0] as RankEntry).rank > e.holeRanks[0];
    if (entry && !last.improved[0] && farther(last)) {
      // The first ranked guess that landed farther than the hole: say what the number means,
      // once.
      const first = events.findIndex(farther);
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
      return t(lang, coarsePointer ? 'tutMeterIntroTap' : 'tutMeterIntroClick').replace(
        '{word}',
        chip(line.hole.word, line.hole.rank),
      );
    case 'meterTapped':
      return t(lang, 'tutMeterTapped');
    case 'activated':
      return t(lang, coarsePointer ? 'tutActivatedTap' : 'tutActivatedClick')
        .replace('{n}', String(GIVEN))
        .replace('{word}', chip(line.hole.word, line.hole.rank));
    case 'found':
      return t(lang, 'tutMeterFound');
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
    case 'solved':
      return t(lang, 'tutSolved').replace('{n}', String(line.tries));
  }
}
