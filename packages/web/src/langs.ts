// Supported game languages — the single source for the picker and the /<lang> URL
// routing. A language is deep-linkable: /fr and /en map to the game in that language,
// / is the picker.
export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French' },
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

// The language selector lives at its own route (not a modal): the HUD flag links here.
export const SELECT_PATH = '/select';

// A parsed route. The game IS the home: /<lang> plays that language, /select is the
// language picker, and anything else (/, unknown paths) is a `home` redirect that
// bounces to the user's language (see resolveHomeLang).
export type Route =
  | { view: 'game'; lang: LangCode }
  | { view: 'select' }
  | { view: 'home' };

export function parseRoute(pathname: string): Route {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  if (isLang(seg)) return { view: 'game', lang: seg };
  if (seg === 'select') return { view: 'select' };
  return { view: 'home' };
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
