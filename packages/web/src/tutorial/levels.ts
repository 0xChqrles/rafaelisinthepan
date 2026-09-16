// THE LEVELS (#269, user-decided 2026-09-16): the tutorial is a LIST of levels, each a way
// of understanding the game one layer deeper — the game itself first, then how the distance
// is computed, then a word holding several meanings at once, then the vectors underneath and
// what the AIs do with them. Level 1 is built; the rest are named here so the list shows the
// road, greyed until each is built (a row with no lesson behind it is not tappable).
//
// Only a BUILT level counts toward the header's badge and the game's LEARN / PLAY invitation:
// a badge for something nobody can do is a nag.
//
// Completion is DEVICE-LOCAL and INFERRED FROM PLAY where it can be (the issue's rule): level
// 1 is done once its run ends on PLAY — or once ANY real round holds a guess, since a person
// who has played has learned what the run teaches. Nothing is stored on the account.
import type { UiKey } from '../i18n';

export interface Level {
  level: number;
  titleKey: UiKey;
  subKey: UiKey;
  built: boolean;
}

export const LEVELS: readonly Level[] = [
  { level: 1, titleKey: 'levelPlayTitle', subKey: 'levelPlaySub', built: true },
  { level: 2, titleKey: 'levelDistanceTitle', subKey: 'levelDistanceSub', built: false },
  { level: 3, titleKey: 'levelMeaningsTitle', subKey: 'levelMeaningsSub', built: false },
  { level: 4, titleKey: 'levelVectorsTitle', subKey: 'levelVectorsSub', built: false },
];

// The one level the game invites into today; named once so the gate, the invitation and
// the inference from play all point at the same row.
export const PLAY_LEVEL = 1;

export function levelOf(n: number): Level | undefined {
  return LEVELS.find((l) => l.level === n);
}

// How many BUILT levels this device has not done — the header badge's number.
export function undoneLevels(done: readonly number[]): number {
  return LEVELS.filter((l) => l.built && !done.includes(l.level)).length;
}
