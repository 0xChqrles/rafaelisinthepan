import type { Article } from './types';

// FRENCH TYPOGRAPHY, applied to a French article's text once, where it is loaded: the space
// before a high punctuation mark (: ; ! ? ») and a unit (% $), the one after «, and the spaces
// that group a number's digits (10 000) become NO-BREAK spaces — a line never starts on a
// colon, and « 130 000 » never splits in two. Written with plain spaces in the source, so the
// text stays readable and editable there.
const NBSP = ' ';

export function frenchSpaces(text: string): string {
  return text
    .replace(/(\d) (?=\d{3}(?!\d))/g, `$1${NBSP}`)
    .replace(/ ([:;!?»%$])/g, `${NBSP}$1`)
    .replace(/« /g, `«${NBSP}`);
}

// Every string of an article through `fix` — prose, captions, figure labels and words alike.
export function typesetArticle(article: Article, fix: (s: string) => string): Article {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return fix(value);
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(article) as Article;
}
