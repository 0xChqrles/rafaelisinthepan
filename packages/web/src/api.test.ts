// CONTRACT: date->puzzle routing (issue #6). For normal play the CLIENT asks the
// BACKEND for "today's puzzle" — it never computes the date. The server owns the
// day; the client passes only `lang`. The ?puzzle= test override is kept (load a
// file directly); the ?date= override is intentionally dropped. A 404 from the
// backend is the graceful "no puzzle today" state, not an error.

import { describe, it, expect } from 'vitest';
import { apiBase, puzzleUrl, todayUrl, resolveOverride, puzzleOutcome, parsePuzzle } from './api';

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

  it('puzzleUrl is version-addressed: it always carries the required `v` token (#42)', () => {
    expect(puzzleUrl('fr', 'abc123', base)).toBe('https://api.example/?lang=fr&v=abc123');
    expect(puzzleUrl('en', 'def456', base)).toBe('https://api.example/?lang=en&v=def456');
  });

  it('puzzleUrl encodes the lang and version query values', () => {
    expect(puzzleUrl('a b', 'v/1"', base)).toBe('https://api.example/?lang=a%20b&v=v%2F1%22');
  });

  it('todayUrl points at the server day-metadata + version pointer, passing lang (#42)', () => {
    expect(todayUrl('fr', base)).toBe('https://api.example/today?lang=fr');
    // lang is optional: callers that only need dayNumber (useToday) omit it.
    expect(todayUrl(undefined, base)).toBe('https://api.example/today');
  });

  it('fails loudly when the backend base is unset instead of using the web origin', () => {
    expect(() => puzzleUrl('fr', 'v1', '')).toThrow(/VITE_API_BASE_URL/);
    expect(() => todayUrl('fr', '')).toThrow(/VITE_API_BASE_URL/);
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

// CONTRACT: the per-puzzle JSON schema (issue #14). A fetched puzzle of the wrong
// shape (truncated body, wrong file behind ?puzzle=, store/CDN mishap) must surface as
// an ERROR — parsePuzzle throws — rather than crash Game mid-render. Assert against the
// schema in AGENTS.md, not the implementation: lang, words[], each hole's {secret,start}
// {word,slug} + start_rank, and a ranks map with an entry for every secret slug.
describe('parsePuzzle (shape validation)', () => {
  // A minimal well-formed puzzle per the schema (accents kept in words/display forms).
  const valid = () => ({
    lang: 'fr',
    words: ['la', 'forêt', 'ancienne'],
    holes: [
      {
        pos: 1,
        secret: { word: 'forêt', slug: 'foret' },
        start: { word: 'bois', slug: 'bois' },
        start_rank: 87,
      },
    ],
    ranks: {
      foret: { bois: { word: 'bois', rank: 87 } },
    },
  });

  it('accepts and returns a well-formed puzzle unchanged', () => {
    const p = valid();
    expect(parsePuzzle(p)).toEqual(p);
  });

  // Optional source metadata (#5): not load-bearing, so a puzzle is valid WITH or
  // WITHOUT it, and when present it must survive to the front (consumed by the solved
  // screen, #8) rather than being stripped.
  it('is valid without a source (optional end-to-end)', () => {
    const p = valid();
    expect('source' in p).toBe(false);
    expect(parsePuzzle(p)).toEqual(p);
  });

  it('passes an optional source (kind/author/work/context) through unchanged', () => {
    const p = {
      ...valid(),
      source: { kind: 'book', author: 'Victor Hugo', work: 'Les Misérables', context: '…' },
    };
    expect(parsePuzzle(p).source).toEqual(p.source);
  });

  it('rejects non-objects (null, array, primitive)', () => {
    expect(() => parsePuzzle(null)).toThrow(/malformed puzzle/);
    expect(() => parsePuzzle([])).toThrow(/malformed puzzle/);
    expect(() => parsePuzzle('nope')).toThrow(/malformed puzzle/);
  });

  it('rejects a missing or non-string lang', () => {
    const p = valid() as Record<string, unknown>;
    delete p.lang;
    expect(() => parsePuzzle(p)).toThrow(/lang/);
  });

  it('rejects words that are not an array of strings', () => {
    const p = valid();
    (p as { words: unknown }).words = ['ok', 3];
    expect(() => parsePuzzle(p)).toThrow(/words/);
  });

  it('rejects holes that are not an array', () => {
    const p = valid();
    (p as { holes: unknown }).holes = {};
    expect(() => parsePuzzle(p)).toThrow(/holes/);
  });

  it('rejects a hole missing a {word,slug} secret/start or a numeric start_rank', () => {
    const noSlug = valid();
    (noSlug.holes[0].secret as { slug?: string }).slug = undefined;
    expect(() => parsePuzzle(noSlug)).toThrow(/holes/);

    const badRank = valid();
    (badRank.holes[0] as { start_rank: unknown }).start_rank = '87';
    expect(() => parsePuzzle(badRank)).toThrow(/holes/);
  });

  it('rejects a ranks map missing an entry for a secret slug', () => {
    const p = valid();
    (p as { ranks: Record<string, unknown> }).ranks = {}; // no "foret" key
    expect(() => parsePuzzle(p)).toThrow(/ranks/);
  });

  it('rejects a non-object ranks', () => {
    const p = valid();
    (p as { ranks: unknown }).ranks = [];
    expect(() => parsePuzzle(p)).toThrow(/ranks/);
  });
});
