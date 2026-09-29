// THE LEVELS (#269, user-decided 2026-09-16; re-cut 2026-09-29 once the game ranked its
// sentences by context): the tutorial is a LIST of levels, each a way of understanding the
// game one layer deeper. Level 1 is the game itself, PLAYED. The others are ARTICLES — the
// author's published piece on how the game measures closeness (chqrles.me/cemantix), cut
// into four explanations with its story taken out: the distance (words as coordinates),
// one word holding several meanings, how a machine reads a sentence, and the judge that
// now orders every daily map.
//
// A level is READY IN A LANGUAGE when its lesson exists in it: `duration` names the
// languages, and says how long the lesson takes in each (the list prints it the way the
// article's page prints its own). A level not ready in the list's language is shown, greyed,
// and says SOON — the road ahead — but is not a target, and the route to it lands on the list.
//
// Only a READY level counts toward the header's badge and the game's LEARN / PLAY invitation:
// a badge for something nobody can do is a nag.
//
// Completion is DEVICE-LOCAL. Level 1 is done once its run ends on PLAY — or once ANY real
// round holds a guess, since a person who has played has learned what the run teaches; an
// article is done once it has been read to its end. Nothing is stored on the account.
import type { UiKey } from '../i18n';

// The illustration each level wears, on the list and at the head of its lesson (art/).
export type LevelArtName = 'game' | 'distance' | 'meanings' | 'attention' | 'judge';

export interface Level {
  level: number;
  titleKey: UiKey;
  subKey: UiKey;
  art: LevelArtName;
  // Seconds the lesson takes, per language it is ready in (absent = not ready there).
  duration: Partial<Record<string, number>>;
}

export const LEVELS: readonly Level[] = [
  { level: 1, titleKey: 'levelPlayTitle', subKey: 'levelPlaySub', art: 'game', duration: { en: 60, fr: 60 } },
  { level: 2, titleKey: 'levelDistanceTitle', subKey: 'levelDistanceSub', art: 'distance', duration: { fr: 290 } },
  { level: 3, titleKey: 'levelMeaningsTitle', subKey: 'levelMeaningsSub', art: 'meanings', duration: { fr: 140 } },
  { level: 4, titleKey: 'levelAttentionTitle', subKey: 'levelAttentionSub', art: 'attention', duration: { fr: 280 } },
  { level: 5, titleKey: 'levelJudgeTitle', subKey: 'levelJudgeSub', art: 'judge', duration: { fr: 430 } },
];

// The one level the game invites into today; named once so the gate, the invitation and
// the inference from play all point at the same row.
export const PLAY_LEVEL = 1;

export function levelOf(n: number): Level | undefined {
  return LEVELS.find((l) => l.level === n);
}

export function isReady(level: Level, lang: string): boolean {
  return level.duration[lang] !== undefined;
}

// The level after `n` that is ready in `lang` — where a finished lesson leads.
export function nextReady(n: number, lang: string): Level | undefined {
  return LEVELS.find((l) => l.level > n && isReady(l, lang));
}

// How many READY levels this device has not done — the header badge's number.
export function undoneLevels(done: readonly number[], lang: string): number {
  return LEVELS.filter((l) => isReady(l, lang) && !done.includes(l.level)).length;
}

// A duration as the article's page prints one: 5′30″, or 60″ under a minute.
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}″`;
  return `${m}′${String(s).padStart(2, '0')}″`;
}
