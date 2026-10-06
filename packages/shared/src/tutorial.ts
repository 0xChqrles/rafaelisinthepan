// THE TUTORIAL'S LEVELS AND THEIR PAGES (#269), in ONE place because two packages have to
// agree on them: the WEB teaches them, and the WhatsApp BOT links them — a question about
// how the game works is answered with the level that explains it. A level the web adds,
// re-cuts or translates is a level the bot links the same day.
//
//   /<lang>/learn       the list of levels
//   /<lang>/learn/<n>   one level's lesson, when it is READY in that language (the web lands
//                       any other `n` on the list)
//
// A level is READY IN A LANGUAGE when its lesson exists in it: `duration` names the
// languages. A NUMBER beside one is an article's reading time, which the list prints; NULL
// is the PLAYED level, ready and untimed — a game takes as long as the player, so no screen
// promises a time for it. What a level is called and what it looks like are the web's
// (`web/src/tutorial/levels.ts`).

export const LEARN_SEGMENT = 'learn';

export function learnPath(lang: string): string {
  return `/${lang}/${LEARN_SEGMENT}`;
}

export function lessonPath(lang: string, level: number): string {
  return `/${lang}/${LEARN_SEGMENT}/${level}`;
}

export interface TutorialLevel {
  level: number;
  // Per language it is ready in (absent = not ready there): an article's reading seconds,
  // or null for the played level. `!` strips null as well as undefined, so a printer must
  // test the value (`!= null`), never assert it.
  duration: Partial<Record<string, number | null>>;
}

// 1 the game, PLAYED · 2 the distance · 3 many meanings · 4 attention · 5 the judge — the
// last four ARTICLES, written in French first.
export const TUTORIAL_LEVELS: readonly TutorialLevel[] = [
  { level: 1, duration: { en: null, fr: null } },
  { level: 2, duration: { fr: 220 } },
  { level: 3, duration: { fr: 90 } },
  { level: 4, duration: { fr: 230 } },
  { level: 5, duration: { fr: 240 } },
];

// The one level the game invites into: the game itself, played.
export const PLAY_LEVEL = 1;

export function isReady(level: TutorialLevel, lang: string): boolean {
  return level.duration[lang] !== undefined;
}
