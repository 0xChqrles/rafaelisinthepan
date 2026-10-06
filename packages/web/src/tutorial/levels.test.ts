import { describe, expect, it } from 'vitest';
import { LANGS as LANG_ROWS } from '../langs';
import { articleFor, readingSeconds } from './articles';
import { LEVELS, PLAY_LEVEL, formatDuration, isReady, nextReady, undoneLevels } from './levels';

const LANGS = LANG_ROWS.map((l) => l.code);

// THE LEVELS (levels.ts) and the lessons behind them must agree: a level is READY in a
// language exactly when its lesson exists there, and the time the list prints is an
// article's reading time — the played level 1 has none to print.
describe('levels ⇔ lessons', () => {
  it('level 1 is the played lesson, ready in every language, with no time to print', () => {
    const one = LEVELS.find((l) => l.level === PLAY_LEVEL)!;
    for (const lang of LANGS) {
      expect(isReady(one, lang), lang).toBe(true);
      expect(one.duration[lang], lang).toBeNull();
    }
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
  it('counts level 1 alone: the articles have no done state', () => {
    for (const lang of LANGS) {
      expect(undoneLevels([], lang)).toBe(1);
      expect(undoneLevels([PLAY_LEVEL], lang)).toBe(0);
      expect(undoneLevels([2, 3, 4, 5], lang)).toBe(1);
    }
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

describe('the shared levels and their faces', () => {
  it('names and draws every level the shared table holds', () => {
    for (const level of LEVELS) {
      expect(level.titleKey, `level ${level.level}`).toBeDefined();
      expect(level.subKey, `level ${level.level}`).toBeDefined();
      expect(level.art, `level ${level.level}`).toBeDefined();
    }
  });
});
