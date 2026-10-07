// THE LEVELS (#269, user-decided 2026-09-16; re-cut 2026-09-29 once the game ranked its
// sentences by context): the tutorial is a LIST of levels, each a way of understanding the
// game one layer deeper. Level 1 is the game itself, PLAYED. The others are ARTICLES — the
// author's published piece on how the game measures closeness (chqrles.me/words-in-context), cut
// into four explanations with its story taken out: the distance (words as coordinates),
// one word holding several meanings, how a machine reads a sentence, and the judge that
// now orders every daily map.
//
// WHICH levels exist, in which languages, and their pages are SHARED (`shared/src/tutorial.ts`):
// the WhatsApp bot links them. What each is called and the picture it wears are here.
//
// A level is READY IN A LANGUAGE when its lesson exists in it: `duration` names the
// languages. An ARTICLE's carries its reading time, which the list prints the way the
// article's page prints its own; level 1, played, carries none (null) — a game takes as long
// as the player, so no screen promises a time for it. A level not ready in the list's
// language is shown, greyed, and says SOON — the road ahead — but is not a target, and the
// route to it lands on the list.
//
// Only LEVEL 1 can be DONE: it is the one the game invites into, and the one the header's
// badge counts (while it is ready in the language and not done). The articles are read, as
// often as anyone likes, and never marked: a level 2 always waiting to be "done" would be a
// badge and a highlight that never go away.
//
// Completion is DEVICE-LOCAL. Level 1 is done once its run is over — its last sentence
// dissolved into the level's card, which turns DONE on screen (PLAY records it too) — or once
// ANY real round holds a guess, since a person who has played has learned what the run
// teaches. Nothing is stored on the account.
import { PLAY_LEVEL, TUTORIAL_LEVELS, isReady, type TutorialLevel } from '@whippin/shared';
import type { UiKey } from '../i18n';

export { PLAY_LEVEL, isReady };

// The illustration each level wears, on the list and at the head of its lesson (art/).
export type LevelArtName = 'game' | 'distance' | 'meanings' | 'attention' | 'judge';

interface LevelFace {
  titleKey: UiKey;
  subKey: UiKey;
  art: LevelArtName;
}

export type Level = TutorialLevel & LevelFace;

const FACES: Record<number, LevelFace> = {
  1: { titleKey: 'levelPlayTitle', subKey: 'levelPlaySub', art: 'game' },
  2: { titleKey: 'levelDistanceTitle', subKey: 'levelDistanceSub', art: 'distance' },
  3: { titleKey: 'levelMeaningsTitle', subKey: 'levelMeaningsSub', art: 'meanings' },
  4: { titleKey: 'levelAttentionTitle', subKey: 'levelAttentionSub', art: 'attention' },
  5: { titleKey: 'levelJudgeTitle', subKey: 'levelJudgeSub', art: 'judge' },
};

export const LEVELS: readonly Level[] = TUTORIAL_LEVELS.map((level) => ({ ...level, ...FACES[level.level] }));

export function levelOf(n: number): Level | undefined {
  return LEVELS.find((l) => l.level === n);
}

// The level after `n` that is ready in `lang` — where a finished lesson leads.
export function nextReady(n: number, lang: string): Level | undefined {
  return LEVELS.find((l) => l.level > n && isReady(l, lang));
}

// The header badge's number: 1 while level 1 is ready in `lang` and this device has not done
// it, else 0 (the only level with a done state).
export function undoneLevels(done: readonly number[], lang: string): number {
  return isReady(levelOf(PLAY_LEVEL)!, lang) && !done.includes(PLAY_LEVEL) ? 1 : 0;
}

// A duration as the article's page prints one: 5′30″, or 60″ under a minute (a screen reader
// is given `spokenDuration` beside it: the primes read as "prime").
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}″`;
  return `${m}′${String(s).padStart(2, '0')}″`;
}
