import { describe, expect, it } from 'vitest';
import { LANGS as LANG_ROWS } from '../langs';
import { articleFor, readingSeconds } from './articles';
import { LEVELS, PLAY_LEVEL, formatDuration, isReady, nextReady, undoneLevels } from './levels';

const LANGS = LANG_ROWS.map((l) => l.code);

// THE LEVELS (levels.ts) and the lessons behind them must agree: a level is READY in a
// language exactly when its lesson exists there, and the duration the list prints is the
// one the lesson takes.
describe('levels ⇔ lessons', () => {
  it('level 1 is the played lesson, ready in every language, one minute long', () => {
    const one = LEVELS.find((l) => l.level === PLAY_LEVEL)!;
    for (const lang of LANGS) expect(one.duration[lang]).toBe(60);
  });

  it('an article level is ready in a language exactly when its article exists there', () => {
    for (const level of LEVELS.filter((l) => l.level !== PLAY_LEVEL)) {
      for (const lang of LANGS) {
        expect(isReady(level, lang), `level ${level.level} in ${lang}`).toBe(articleFor(lang, level.level) !== undefined);
      }
    }
  });

  it('prints the reading time the article takes', () => {
    for (const level of LEVELS.filter((l) => l.level !== PLAY_LEVEL)) {
      for (const lang of LANGS) {
        const article = articleFor(lang, level.level);
        if (article) expect(level.duration[lang], `level ${level.level} in ${lang}`).toBe(readingSeconds(article));
      }
    }
  });

  it('numbers the levels 1…n in order', () => {
    expect(LEVELS.map((l) => l.level)).toEqual(LEVELS.map((_, i) => i + 1));
  });
});

describe('what the list and the badge read', () => {
  it('counts only the levels ready in the language', () => {
    const readyFr = LEVELS.filter((l) => isReady(l, 'fr')).length;
    const readyEn = LEVELS.filter((l) => isReady(l, 'en')).length;
    expect(undoneLevels([], 'fr')).toBe(readyFr);
    expect(undoneLevels([], 'en')).toBe(readyEn);
    expect(undoneLevels([PLAY_LEVEL], 'en')).toBe(readyEn - 1);
  });

  it('leads a finished level to the next one ready in the language, none after the last', () => {
    for (const lang of LANGS) {
      const ready = LEVELS.filter((l) => isReady(l, lang)).map((l) => l.level);
      ready.forEach((n, i) => expect(nextReady(n, lang)?.level).toBe(ready[i + 1]));
    }
  });

  it('prints a duration the way the article page does', () => {
    expect(formatDuration(60)).toBe('1′00″');
    expect(formatDuration(330)).toBe('5′30″');
    expect(formatDuration(45)).toBe('45″');
  });
});
