import { FIRST_PUZZLE_DATE } from './config';

// Supported game languages — the single source for the picker and the /<lang> URL
// routing. A language is deep-linkable: /fr and /en map to the game in that language,
// / is the picker. `native` is the name in the language ITSELF — a language picker
// must be readable by the person who needs that language, so the list never
// translates the names.
export const LANGS = [
  { code: 'en', native: 'English' },
  { code: 'fr', native: 'Français' },
] as const;

export type LangCode = (typeof LANGS)[number]['code'];

const CODES: readonly string[] = LANGS.map((l) => l.code);

export function isLang(value: string | null | undefined): value is LangCode {
  return value != null && CODES.includes(value);
}

// The two daily games (#156): the sentence puzzle, and Word mode — one word, claim its
// neighborhood against a countdown. One app, two faces: the mode is part of every identity
// (URL, round key, share token), and the URL grammar gives Word mode its own segment —
// sentence keeps /<lang> and /<lang>/<date>, Word mode lives under /<lang>/word.
export type Mode = 'sentence' | 'word';
const WORD_SEGMENT = 'word';

// A mode's home for a language: /<lang> (sentence) or /<lang>/word.
export function pathForMode(lang: string | null, mode: Mode): string {
  if (!isLang(lang)) return '/';
  return mode === 'word' ? `/${lang}/${WORD_SEGMENT}` : `/${lang}`;
}

// The archive calendar for a language (and mode): /<lang>/archive or /<lang>/word/archive.
export function pathForArchive(lang: string | null, mode: Mode = 'sentence'): string {
  if (!isLang(lang)) return '/';
  return mode === 'word' ? `/${lang}/${WORD_SEGMENT}/archive` : `/${lang}/archive`;
}

// A past day's game, deep-linkable/shareable: /<lang>/<YYYY-MM-DD>, or Word mode's
// /<lang>/word/<YYYY-MM-DD>. The caller supplies a valid ISO date; range validation
// happens in parseRoute on the way back in.
export function pathForDay(lang: string | null, date: string, mode: Mode = 'sentence'): string {
  if (!isLang(lang)) return '/';
  return mode === 'word' ? `/${lang}/${WORD_SEGMENT}/${date}` : `/${lang}/${date}`;
}

// The language chooser lives at its own route (not a modal), opened by the header's
// language chip. It sits above /<lang> since it is not language-scoped. (The /mode
// chooser was RETIRED 2026-08-18 for the header's segmented mode tabs.)
export const SELECT_PATH = '/select';

// The profile editor (#188) is its own route for the same reason: the identity is
// global, not language-scoped. The leaderboard screen (#190) is its wired entry point.
export const PROFILE_PATH = '/profile';

// A parsed route. The game IS the home: /<lang> plays today's puzzle, /<lang>/<date>
// plays a past day (archive, #55), /<lang>/archive is the calendar, /select is the
// language picker, and anything else (/, unknown paths) is
// a `home` redirect that bounces to the user's language (see resolveHomeLang). Word
// mode (#156) mirrors the whole grammar under /<lang>/word: today's word,
// /word/<date>, /word/archive.
export type Route =
  | { view: 'game'; lang: LangCode; mode: Mode; date?: string }
  | { view: 'archive'; lang: LangCode; mode: Mode }
  | { view: 'select' }
  | { view: 'profile' }
  | { view: 'home' };

// A strict "YYYY-MM-DD" that is ALSO a real calendar date (so 2026-13-40 is rejected):
// the shape guards the format, the round-trip re-formats the parsed value and requires
// it to match, which weeds out impossible days (Feb 30) and normalized overflow.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

// Range bounds for date deep-links, injected so parsing stays pure/testable. `firstDate`
// defaults to the launch const; `activeDate` is the client's active game day (the caller
// passes it) — omitted, the future bound is not enforced (used by shape-only tests).
export interface RouteBounds {
  firstDate?: string;
  activeDate?: string;
}

export function parseRoute(pathname: string, bounds: RouteBounds = {}): Route {
  const firstDate = bounds.firstDate ?? FIRST_PUZZLE_DATE;
  const segs = pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  const [seg, second, third] = segs;
  if (seg === 'select') return { view: 'select' };
  if (seg === 'profile') return { view: 'profile' };
  if (!isLang(seg)) return { view: 'home' };

  // A dated deep link is honored only when it is a real calendar date within range; a
  // date-SHAPED segment that is malformed OR out of range is treated as unknown -> home
  // (a clearly date-like deep link that is broken should not silently fall through to
  // today). Shared by both modes, so the two grammars cannot drift.
  const dateOf = (s: string): string | 'home' | null => {
    if (!DATE_RE.test(s)) return null; // not date-shaped at all
    if (!isCalendarDate(s)) return 'home';
    if (s < firstDate) return 'home';
    if (bounds.activeDate && s > bounds.activeDate) return 'home';
    return s;
  };

  // /<lang>/word[/...] — Word mode (#156), the same grammar one segment deeper.
  if (second === WORD_SEGMENT) {
    if (!third) return { view: 'game', lang: seg, mode: 'word' };
    if (third === 'archive') return { view: 'archive', lang: seg, mode: 'word' };
    const date = dateOf(third);
    if (date === 'home') return { view: 'home' };
    if (date) return { view: 'game', lang: seg, mode: 'word', date };
    // Non-date, non-archive third segment: today's word, same tolerance as the sentence.
    return { view: 'game', lang: seg, mode: 'word' };
  }

  // /<lang> — today's game.
  if (!second) return { view: 'game', lang: seg, mode: 'sentence' };
  // /<lang>/archive — the calendar.
  if (second === 'archive') return { view: 'archive', lang: seg, mode: 'sentence' };
  // /<lang>/<YYYY-MM-DD> — a past day.
  const date = dateOf(second);
  if (date === 'home') return { view: 'home' };
  if (date) return { view: 'game', lang: seg, mode: 'sentence', date };
  // Any other non-date, non-archive segment keeps today's tolerance: /<lang>/xyz plays
  // today's game (unchanged behavior, so old links never break).
  return { view: 'game', lang: seg, mode: 'sentence' };
}

// Where `/` (and any unknown path) should land: the persisted last-played language if
// valid, else the browser's preferred language (fr* -> fr), else English. Pure so it
// can be unit-tested — the caller passes navigator.language.
export function resolveHomeLang(
  persisted: string | null | undefined,
  navigatorLang?: string,
): LangCode {
  if (isLang(persisted)) return persisted;
  if (navigatorLang && navigatorLang.toLowerCase().startsWith('fr')) return 'fr';
  return 'en';
}
