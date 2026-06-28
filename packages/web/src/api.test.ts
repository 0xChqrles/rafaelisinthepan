// CONTRACT: date->puzzle routing (issue #6). For normal play the CLIENT asks the
// BACKEND for "today's puzzle" — it never computes the date. The server owns the
// day; the client passes only `lang`. The ?puzzle= test override is kept (load a
// file directly); the ?date= override is intentionally dropped. A 404 from the
// backend is the graceful "no puzzle today" state, not an error.

import { describe, it, expect } from 'vitest';
import { apiBase, puzzleUrl, todayUrl, resolveOverride, puzzleOutcome } from './api';

describe('apiBase', () => {
  it('reads VITE_API_BASE_URL and trims trailing slashes', () => {
    expect(apiBase({ VITE_API_BASE_URL: 'https://api.example' } as ImportMetaEnv)).toBe(
      'https://api.example',
    );
    expect(apiBase({ VITE_API_BASE_URL: 'https://api.example///' } as ImportMetaEnv)).toBe(
      'https://api.example',
    );
  });

  it('is empty when unset (no backend configured)', () => {
    expect(apiBase({} as ImportMetaEnv)).toBe('');
  });
});

describe('backend routing URLs', () => {
  const base = 'https://api.example';

  it('puzzleUrl asks the backend for the day, passing only lang', () => {
    expect(puzzleUrl('fr', base)).toBe('https://api.example/?lang=fr');
    expect(puzzleUrl('en', base)).toBe('https://api.example/?lang=en');
  });

  it('puzzleUrl encodes the lang query value', () => {
    expect(puzzleUrl('a b', base)).toBe('https://api.example/?lang=a%20b');
  });

  it('todayUrl points at the server day-metadata endpoint', () => {
    expect(todayUrl(base)).toBe('https://api.example/today');
  });

  it('fails loudly when the backend base is unset instead of using the web origin', () => {
    expect(() => puzzleUrl('fr', '')).toThrow(/VITE_API_BASE_URL/);
    expect(() => todayUrl('')).toThrow(/VITE_API_BASE_URL/);
  });
});

describe('resolveOverride (?puzzle= kept, ?date= dropped)', () => {
  it('returns null with no override -> normal play hits the backend', () => {
    expect(resolveOverride('', '/')).toBeNull();
    expect(resolveOverride('?lang=fr', '/')).toBeNull();
  });

  it('ignores ?date= entirely (no longer routes)', () => {
    expect(resolveOverride('?date=2026-06-28', '/')).toBeNull();
  });

  it('resolves a relative ?puzzle path against BASE_URL', () => {
    expect(resolveOverride('?puzzle=word/fr/a_b_c.json', '/')).toBe('/word/fr/a_b_c.json');
    // Honors a non-root deploy base and strips leading slashes off the path.
    expect(resolveOverride('?puzzle=/word/fr/a_b_c.json', '/game/')).toBe(
      '/game/word/fr/a_b_c.json',
    );
  });

  it('uses an absolute http(s) ?puzzle URL verbatim', () => {
    expect(resolveOverride('?puzzle=https://cdn.example/p.json', '/')).toBe(
      'https://cdn.example/p.json',
    );
  });
});

describe('puzzleOutcome (graceful 404)', () => {
  it('200/2xx -> a puzzle to load', () => {
    expect(puzzleOutcome(200)).toBe('puzzle');
    expect(puzzleOutcome(204)).toBe('puzzle');
  });

  it('404 -> missing (the NO PUZZLE TODAY state, not an error)', () => {
    expect(puzzleOutcome(404)).toBe('missing');
  });

  it('any other status -> a real error', () => {
    expect(puzzleOutcome(500)).toBe('error');
    expect(puzzleOutcome(403)).toBe('error');
  });
});
