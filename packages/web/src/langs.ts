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
