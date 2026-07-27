// CONTRACT: date->puzzle routing (issue #6). The CLIENT computes the active 22:00-ET
// game day (shared day.ts) and requests the DATE-addressed puzzle URL in one fetch;
// the server validates the date against its clock-skew window and serves exactly that
// day. A 404 from the backend is the graceful "no puzzle today" state, not an error.

import { describe, it, expect } from 'vitest';
import { apiBase, puzzleUrl, puzzleOutcome, parsePuzzle } from './api';

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

  it('puzzleUrl is date-addressed: it always carries the required game day', () => {
    expect(puzzleUrl('fr', '2026-07-05', base)).toBe('https://api.example/?lang=fr&date=2026-07-05');
    expect(puzzleUrl('en', '2026-07-06', base)).toBe('https://api.example/?lang=en&date=2026-07-06');
  });

  it('puzzleUrl encodes the lang and date query values', () => {
    expect(puzzleUrl('a b', 'x/y"', base)).toBe('https://api.example/?lang=a%20b&date=x%2Fy%22');
  });

  it('fails loudly when the backend base is unset instead of using the web origin', () => {
    expect(() => puzzleUrl('fr', '2026-07-05', '')).toThrow(/VITE_API_BASE_URL/);
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
// shape (truncated body, store/CDN mishap) must surface as
// an ERROR — parsePuzzle throws — rather than crash Game mid-render. Assert against the
// schema in AGENTS.md, not the implementation: lang, words[], each hole's {secret,start}
// {word,slug} + start_rank, a ranks map with an entry for every secret slug, and the
// optional benchmark entries introduced by #68.
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

  const validBenchmark = () => [
    {
      model: 'claude-opus-4-8',
      label: 'CLAUDE OPUS',
      tag: 'OPUS',
      tries: 2,
      run: ['bois', 'forêt'],
    },
    {
      model: 'claude-sonnet-5',
      label: 'CLAUDE SONNET',
      tag: 'SONNET',
      tries: 3,
      run: ['arbre', 'bois', 'forêt'],
    },
    {
      model: 'gpt-5.6-sol',
      label: 'GPT-5.6',
      tag: 'GPT',
      tries: null,
      run: ['arbre', 'bois', 'nature'],
    },
  ];

  it('accepts and returns a well-formed puzzle unchanged', () => {
    const p = valid();
    expect(parsePuzzle(p)).toEqual(p);
  });

  it('accepts repeated hole occurrences that share one secret rank map', () => {
    const p = valid();
    p.words = ['la', 'forêt,', 'traverse', 'la', 'forêt'];
    p.holes.push({ ...p.holes[0], pos: 4 });
    Object.assign(p.holes[0], { pos: 1, suffix: ',' });

    expect(parsePuzzle(p)).toEqual(p);
    expect(parsePuzzle(p).holes).toHaveLength(2);
    expect(Object.keys(parsePuzzle(p).ranks)).toEqual(['foret']);
  });

  // Optional source metadata (#5): not load-bearing, so a puzzle is valid WITH or
  // WITHOUT it, and when present it must survive to the front (consumed by the solved
  // screen, #8) rather than being stripped.
  it('is valid without a source (optional end-to-end)', () => {
    const p = valid();
    expect('source' in p).toBe(false);
    expect(parsePuzzle(p)).toEqual(p);
  });

  it('passes an optional source (kind/author/work) through unchanged', () => {
    const p = {
      ...valid(),
      source: { kind: 'book', author: 'Victor Hugo', work: 'Les Misérables' },
    };
    expect(parsePuzzle(p).source).toEqual(p.source);
  });

  it('accepts an absent benchmark (existing puzzles stay byte-compatible)', () => {
    const p = valid();
    expect('benchmark' in p).toBe(false);
    expect(parsePuzzle(p)).toEqual(p);
  });

  it('accepts a recorded model set of any size, median runs, and a null DNF', () => {
    const p = { ...valid(), benchmark: validBenchmark() };
    expect(parsePuzzle(p).benchmark).toEqual(p.benchmark);
    // Variable length: every tested model is recorded, the front end filters the display
    // trio, so one entry or four distinct entries are equally valid.
    const one = { ...valid(), benchmark: validBenchmark().slice(0, 1) };
    expect(parsePuzzle(one).benchmark).toEqual(one.benchmark);
    const four = {
      ...valid(),
      benchmark: [
        ...validBenchmark(),
        { model: 'k3', label: 'KIMI K3', tag: 'KIMI', tries: 4, run: ['a', 'b', 'c', 'd'] },
      ],
    };
    expect(parsePuzzle(four).benchmark).toEqual(four.benchmark);
  });

  it('rejects malformed benchmark containers and entries', () => {
    const notArray = { ...valid(), benchmark: {} };
    expect(() => parsePuzzle(notArray)).toThrow(/benchmark/);
    expect(() => parsePuzzle({ ...valid(), benchmark: [] })).toThrow(/benchmark/);
    // A repeated entry (duplicate model + tag) is rejected regardless of array length.
    expect(() =>
      parsePuzzle({ ...valid(), benchmark: [...validBenchmark(), validBenchmark()[0]] }),
    ).toThrow(/unique/);

    const malformed = [
      { model: '', label: 'GPT-5.6', tag: 'GPT', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: ' ', tag: 'GPT', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: ' GPT-5.6', tag: 'GPT', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'lower', tag: 'GPT', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6!', tag: 'GPT', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: '', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'TOOLONG', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'gpt', tries: 12, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: 0, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: 1.5, run: ['forêt'] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: 12, run: 'forêt' },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: 12, run: [''] },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', tries: 1, run: [] },
      {
        model: 'gpt-5.6-sol',
        label: 'GPT-5.6',
        tag: 'GPT',
        tries: 2,
        run: ['forêt'],
      },
      {
        model: 'gpt-5.6-sol',
        label: 'GPT-5.6',
        tag: 'GPT',
        tries: 2,
        run: ['forêt', 'foret'],
      },
      { model: 'gpt-5.6-sol', label: 'GPT-5.6', tag: 'GPT', run: ['forêt'] },
    ];
    for (const entry of malformed) {
      const entries: unknown[] = validBenchmark();
      entries[2] = entry;
      expect(() => parsePuzzle({ ...valid(), benchmark: entries })).toThrow(/benchmark/);
    }
  });

  it('rejects duplicate model identities among recorded entries', () => {
    const benchmark = validBenchmark();
    benchmark[2] = { ...benchmark[2], model: benchmark[0].model };
    expect(() => parsePuzzle({ ...valid(), benchmark })).toThrow(/unique/);
  });

  it('rejects duplicate compact tags among recorded entries', () => {
    const benchmark = validBenchmark();
    benchmark[2] = { ...benchmark[2], tag: benchmark[0].tag };
    expect(() => parsePuzzle({ ...valid(), benchmark })).toThrow(/unique/);
  });

  // Optional distance annotations (#115): dq/road are group properties generation adds
  // to every ranked entry. Every puzzle published before them lacks them, so ABSENT
  // stays valid; a PRESENT one must be a well-formed number.
  it('accepts rank entries with and without dq/road (legacy puzzles stay valid)', () => {
    const p = valid();
    expect('dq' in p.ranks.foret.bois).toBe(false);
    expect(parsePuzzle(p)).toEqual(p);

    const annotated = valid();
    annotated.ranks = {
      foret: {
        bois: { word: 'bois', rank: 87, dq: 231, road: 1 },
        arbre: { word: 'arbre', rank: 3, dq: 250 }, // beyond the roads, dq alone
        foret: { word: 'forêt', rank: 0 }, // the secret: terminus, no annotations
      },
    } as typeof annotated.ranks;
    expect(parsePuzzle(annotated)).toEqual(annotated);
  });

  it('rejects an out-of-range or non-numeric dq or road', () => {
    const bad = (entry: Record<string, unknown>) => ({
      ...valid(),
      ranks: { foret: { bois: { word: 'bois', rank: 87, ...entry } } },
    });
    expect(() => parsePuzzle(bad({ dq: 300 }))).toThrow(/dq/);
    expect(() => parsePuzzle(bad({ dq: -1 }))).toThrow(/dq/);
    expect(() => parsePuzzle(bad({ dq: 12.5 }))).toThrow(/dq/);
    expect(() => parsePuzzle(bad({ dq: 'x' }))).toThrow(/dq/);
    expect(() => parsePuzzle(bad({ road: -1 }))).toThrow(/road/);
    expect(() => parsePuzzle(bad({ road: 1.5 }))).toThrow(/road/);
    expect(() => parsePuzzle(bad({ road: '0' }))).toThrow(/road/);
    // A road id is an INDEX the route view draws a lane for, so it is bounded above as well:
    // `4294967295` parses as a fine non-negative integer and is a number nothing downstream
    // can do anything sane with. The ceiling stays far above any clustering that could ship —
    // a puzzle rejected here costs the whole day.
    expect(() => parsePuzzle(bad({ road: 4294967295 }))).toThrow(/road/);
    expect(() => parsePuzzle(bad({ road: 64 }))).toThrow(/road/);
    expect(parsePuzzle(bad({ road: 63 }))).toBeTruthy();
  });

  // Optional hole affixes: display-only text around the blank (leading clitic /
  // punctuation). Not load-bearing, so a hole is valid with or without them, and when
  // present they must survive to the front (Phrase renders them around the blank).
  it('passes optional hole prefix/suffix through unchanged', () => {
    const p = valid();
    Object.assign(p.holes[0], { prefix: "t'", suffix: ',' });
    const parsed = parsePuzzle(p);
    expect(parsed.holes[0].prefix).toBe("t'");
    expect(parsed.holes[0].suffix).toBe(',');
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
