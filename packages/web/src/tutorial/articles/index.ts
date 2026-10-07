// The article levels' text, per language (levels.ts says which levels are ready where; a
// test holds the two to each other). Reached only through the lazy lesson chunk.
import type { Article } from './types';
import { EN_ARTICLES } from './en';
import { FR_ARTICLES } from './fr';

const ARTICLES: Partial<Record<string, Record<number, Article>>> = { en: EN_ARTICLES, fr: FR_ARTICLES };

export function articleFor(lang: string, level: number): Article | undefined {
  return ARTICLES[lang]?.[level];
}

// Every piece of text a reader reads, in order — the reading time is counted on it.
export function articleText(article: Article): string[] {
  const out: string[] = [];
  for (const section of article.sections) {
    if (section.heading) out.push(section.heading);
    for (const block of section.blocks) {
      if ('p' in block) out.push(block.p);
      else if ('quote' in block) out.push(block.quote);
      else if ('sentence' in block) out.push(...block.sentence);
      else if ('code' in block) out.push(...block.code);
      else if ('terms' in block) out.push(...block.terms.flat());
      else if ('steps' in block) out.push(...block.steps);
      else out.push(block.caption);
    }
  }
  return out;
}

// Reading time in seconds, rounded to ten: words at the article page's own pace (its 23′32″
// for about five thousand words), plus a few seconds per figure to look at it.
const WORDS_PER_MINUTE = 215;
const SECONDS_PER_FIGURE = 6;
export function readingSeconds(article: Article): number {
  const words = articleText(article)
    .join(' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const figures = article.sections.reduce((n, s) => n + s.blocks.filter((b) => 'fig' in b).length, 0);
  const seconds = (words / WORDS_PER_MINUTE) * 60 + figures * SECONDS_PER_FIGURE;
  return Math.round(seconds / 10) * 10;
}
