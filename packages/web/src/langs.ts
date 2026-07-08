import { FIRST_PUZZLE_DATE } from './config';

// Supported game languages — the single source for the picker and the /<lang> URL
// routing. A language is deep-linkable: /fr and /en map to the game in that language,
// / is the picker. `native` is the name in the language ITSELF — a language picker
// must be readable by the person who needs that language, so the list never
// translates the names.
export const LANGS = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'fr', label: 'French', native: 'Français' },
] as const;

export type LangCode = (typeof LANGS)[number]['code'];

const CODES: readonly string[] = LANGS.map((l) => l.code);

export function isLang(value: string | null | undefined): value is LangCode {
  return value != null && CODES.includes(value);
}

// The language encoded by a URL path (its first segment), or null for the picker /
// any unknown path. Trailing slashes and extra segments are tolerated (/fr/ -> fr).
export function langFromPath(pathname: string): LangCode | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  return isLang(seg) ? seg : null;
}

// The canonical path for a language: /<lang>, or / for the picker (no/unknown lang).
export function pathForLang(lang: string | null): string {
  return isLang(lang) ? `/${lang}` : '/';
}

// The archive calendar for a language: /<lang>/archive (or / for an unknown lang).
export function pathForArchive(lang: string | null): string {
  return isLang(lang) ? `/${lang}/archive` : '/';
}

// A past day's game, deep-linkable/shareable: /<lang>/<YYYY-MM-DD>. The caller supplies
// a valid ISO date; range validation happens in parseRoute on the way back in.
export function pathForDay(lang: string | null, date: string): string {
  return isLang(lang) ? `/${lang}/${date}` : '/';
}

// The language selector lives at its own route (not a modal): the HUD flag links here.
export const SELECT_PATH = '/select';

// A parsed route. The game IS the home: /<lang> plays today's puzzle, /<lang>/<date>
// plays a past day (archive, #55), /<lang>/archive is the calendar, /select is the
// language picker, and anything else (/, unknown paths) is a `home` redirect that
// bounces to the user's language (see resolveHomeLang).
export type Route =
  | { view: 'game'; lang: LangCode; date?: string }
  | { view: 'archive'; lang: LangCode }
  | { view: 'select' }
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
  const [seg, second] = segs;
  if (seg === 'select') return { view: 'select' };
  if (!isLang(seg)) return { view: 'home' };
  // /<lang> — today's game.
  if (!second) return { view: 'game', lang: seg };
  // /<lang>/archive — the calendar.
  if (second === 'archive') return { view: 'archive', lang: seg };
  // /<lang>/<YYYY-MM-DD> — a past day, if it is a real date within range. A date-SHAPED
  // segment that is malformed OR out of range is treated as unknown -> home (a clearly
  // date-like deep link that is broken should not silently fall through to today).
  if (DATE_RE.test(second)) {
    if (!isCalendarDate(second)) return { view: 'home' };
    if (second < firstDate) return { view: 'home' };
    if (bounds.activeDate && second > bounds.activeDate) return { view: 'home' };
    return { view: 'game', lang: seg, date: second };
  }
  // Any other non-date, non-archive segment keeps today's tolerance: /<lang>/xyz plays
  // today's game (unchanged behavior, so old links never break).
  return { view: 'game', lang: seg };
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
