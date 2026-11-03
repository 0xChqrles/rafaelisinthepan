// CONTRACT: the PLAY RECORD is what the curator calibrates its difficulty forecast on, so the
// line's numbers are a cross-package fact. Each round's play log is the raw log deduped by the
// shared `guessKey` (first occurrence kept); T_find is the 1-based try a secret's rank 0 was
// first hit; a day counts only its engaged, on-time rounds of the artifact's revision.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Puzzle } from '@whippin/shared';
import {
  appendPlayed,
  dayClosesAt,
  groupRounds,
  playedEntry,
  playedRecordPath,
  playLog,
  recordedDays,
  tallyRounds,
  type PlayedRound,
} from './played';

// Twenty ranked neighbours for `mats`, inserted FARTHEST first: the nearest list is ordered
// by rank, never by the map's key order.
const matsMap: Puzzle['ranks'][string] = { mats: { word: 'mats', rank: 0 } };
for (let i = 20; i >= 1; i -= 1) {
  matsMap[`n${String.fromCharCode(96 + i)}`] = { word: `near${i}`, rank: i, dq: 0 };
}

const puzzle: Puzzle = {
  lang: 'en',
  words: ['the', 'cat', 'sat', 'on', 'mats.'],
  holes: [
    { pos: 1, secret: { word: 'cat', slug: 'cat' }, start: { word: 'animal', slug: 'animal' }, start_rank: 3 },
    { pos: 2, secret: { word: 'sat', slug: 'sat' }, start: { word: 'stood', slug: 'stood' }, start_rank: 2 },
    { pos: 4, secret: { word: 'mats', slug: 'mats' }, start: { word: 'near20', slug: 'nt' }, start_rank: 20, suffix: '.' },
  ],
  ranks: {
    cat: {
      cat: { word: 'cat', rank: 0 },
      cats: { word: 'cat', rank: 0 }, // an alias of the secret's own group
      dog: { word: 'dog', rank: 1, dq: 255 },
      kitten: { word: 'kitten', rank: 2, dq: 128 },
      kitty: { word: 'kitty', rank: 2, dq: 128 }, // a tie of rank: the FIRST key's word wins
      animal: { word: 'animal', rank: 3, dq: 0 },
    },
    sat: {
      sat: { word: 'sat', rank: 0 },
      sit: { word: 'sat', rank: 0 },
      lay: { word: 'lay', rank: 1, dq: 255 },
      stood: { word: 'stood', rank: 2, dq: 0 },
    },
    mats: matsMap,
  },
  revision: 'rev1',
};

const DAY = '2026-10-20';
// 2026-10-20 runs from 22:00 New York (EDT) on the 19th to 22:00 on the 20th.
const ON = '2026-10-20T15:00:00.000Z';
const ON_EDGE = '2026-10-20T02:30:00.000Z'; // 22:30 New York on the 19th: already the 20th
const LATE = '2026-10-21T03:00:00.000Z'; // 23:00 New York on the 20th: the 21st
const EARLY = '2026-10-19T20:00:00.000Z'; // 16:00 New York on the 19th: the 19th

const misses = (n: number) => Array.from({ length: n }, (_, i) => `miss${String.fromCharCode(97 + i)}`);
const round = (guesses: string[], createdAt = ON, revision = 'rev1'): PlayedRound => ({
  guesses,
  createdAt,
  puzzle: revision,
});

// The cat in two surfaces (one try), every secret found by try 5.
const r1 = round(['dog', 'cats', 'cat', 'sit', 'na', 'mats']);
// A miss typed twice (one try); only `sat` found, at try 3.
const r2 = round(['zzz', 'qqq', 'zzz', 'sat'], ON_EDGE);
// 24 misses first: cat at try 25, sat at 26, mats at 27.
const r3 = round([...misses(24), 'cat', 'sat', 'mats']);
const late = round(['cat', 'sat', 'mats'], LATE);
const early = round(['cat', 'sat', 'mats'], EARLY);
const retired = round(['cat', 'sat', 'mats'], ON, 'rev0');
const empty = round([]);

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const ln = Math.log;

describe('the play log', () => {
  it('dedups by the shared guessKey, the first occurrence kept', () => {
    expect(playLog(puzzle.ranks, r1.guesses)).toEqual(['dog', 'cats', 'sit', 'na', 'mats']);
    expect(playLog(puzzle.ranks, r2.guesses)).toEqual(['zzz', 'qqq', 'sat']);
  });

  it('counts only engaged, on-time rounds of the artifact revision', () => {
    const tally = tallyRounds(puzzle, DAY, [r1, r2, r3, late, early, retired, empty]);
    expect(tally.counted).toHaveLength(3);
    expect(tally).toMatchObject({ retired: 1, offDay: 2, empty: 1 });
  });
});

describe('the play record line', () => {
  const recordedAt = new Date('2026-10-22T10:00:00.000Z');
  const entry = playedEntry(puzzle, DAY, [r1, r2, r3, late, early, retired, empty], recordedAt)!;

  it('carries the day, the revision, the sentence and the holes verbatim', () => {
    expect(entry.day).toBe(DAY);
    expect(entry.lang).toBe('en');
    expect(entry.revision).toBe('rev1');
    expect(entry.recordedAt).toBe('2026-10-22T10:00:00.000Z');
    expect(entry.words).toEqual(puzzle.words);
    expect(entry.holes).toEqual(puzzle.holes);
    expect(Object.keys(entry)).toEqual([
      'day', 'lang', 'revision', 'recordedAt', 'words', 'holes', 'nearest',
      'players', 'finished', 'logTries30', 'found',
    ]);
  });

  it('reads T_find and T_finish off the deduped log, under the caps', () => {
    expect(entry.players).toBe(3);
    // Finishes: r1 at 5, r2 never (ln 30), r3 at 27.
    expect(entry.finished).toBe(r4(2 / 3));
    expect(entry.logTries30).toBe(r4((ln(5) + ln(30) + ln(27)) / 3));
    expect(Object.keys(entry.found)).toEqual(['cat', 'sat', 'mats']);
    // cat: 2, never, 25 — a find at 25 counts ln 20, yet is within 30.
    expect(entry.found.cat).toEqual({ logTries20: r4((ln(2) + ln(20) + ln(20)) / 3), within30: r4(2 / 3) });
    // sat: 3, 3, 26.
    expect(entry.found.sat).toEqual({ logTries20: r4((ln(3) + ln(3) + ln(20)) / 3), within30: 1 });
    // mats: 5, never, 27.
    expect(entry.found.mats).toEqual({ logTries20: r4((ln(5) + ln(20) + ln(20)) / 3), within30: r4(2 / 3) });
  });

  it('lists each secret\'s first 15 ranks, ascending, with the first key\'s word on a tie', () => {
    expect(entry.nearest.cat).toEqual([[1, 'dog'], [2, 'kitten'], [3, 'animal']]);
    expect(entry.nearest.sat).toEqual([[1, 'lay'], [2, 'stood']]);
    expect(entry.nearest.mats).toEqual(Array.from({ length: 15 }, (_, i) => [i + 1, `near${i + 1}`]));
  });

  it('is null when no engaged on-time round of the revision exists', () => {
    expect(playedEntry(puzzle, DAY, [late, early, retired, empty], recordedAt)).toBeNull();
    expect(playedEntry(puzzle, DAY, [], recordedAt)).toBeNull();
  });
});

describe('the day boundary', () => {
  it('closes a day at 22:00 New York on its date, summer and winter', () => {
    expect(dayClosesAt('2026-10-20').toISOString()).toBe('2026-10-21T02:00:00.000Z');
    expect(dayClosesAt('2026-12-10').toISOString()).toBe('2026-12-11T03:00:00.000Z');
  });
});

describe('the round rows', () => {
  it('groups by (day, lang), sorted, and leaves bonus rounds out', () => {
    const item = (sk: string, guesses: string[]) => ({
      pk: { S: 'round#abcdefghijklmnop' },
      sk: { S: sk },
      guesses: { L: guesses.map((g) => ({ S: g })) },
      createdAt: { S: ON },
      puzzle: { S: 'rev1' },
    });
    const days = groupRounds([
      item('fr#sentence#2026-10-20', ['chat']),
      item('en#sentence#2026-10-20', ['cat']),
      item('en#sentence#bonus/1234567', ['cat']),
      item('en#sentence#2026-10-19', ['dog']),
      item('en#sentence#2026-10-20', ['sat']),
    ]);
    expect(days.map((d) => [d.day, d.lang, d.rounds.length])).toEqual([
      ['2026-10-19', 'en', 1],
      ['2026-10-20', 'en', 2],
      ['2026-10-20', 'fr', 1],
    ]);
    expect(days[1].rounds[0]).toEqual({ guesses: ['cat'], createdAt: ON, puzzle: 'rev1' });
  });
});

describe('the record file', () => {
  it('lives beside the publish ledger, whatever the working directory', () => {
    expect(playedRecordPath()).toMatch(/packages\/generation\/played\.jsonl$/);
  });

  it('appends only the days it does not hold, sorted, never rewriting one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'played-'));
    try {
      const file = path.join(dir, 'played.jsonl');
      expect(await recordedDays(file)).toEqual(new Set());
      // A seeded line, its newline missing: it stays byte for byte.
      const seeded = '{"day":"2026-10-20","lang":"en","seeded":true}';
      await writeFile(file, seeded, 'utf8');
      const at = new Date('2026-10-22T10:00:00.000Z');
      const today = playedEntry(puzzle, DAY, [r1], at)!;
      const frDay = { ...playedEntry(puzzle, '2026-10-19', [round(['cat'], '2026-10-19T15:00:00.000Z')], at)!, lang: 'fr' };
      const enDay = playedEntry(puzzle, '2026-10-19', [round(['sat'], '2026-10-19T15:00:00.000Z')], at)!;
      const appended = await appendPlayed([today, frDay, enDay], file);
      expect(appended.map((e) => [e.day, e.lang])).toEqual([['2026-10-19', 'en'], ['2026-10-19', 'fr']]);
      const lines = (await readFile(file, 'utf8')).split('\n');
      expect(lines[0]).toBe(seeded);
      expect(lines.slice(1, 3).map((l) => JSON.parse(l))).toEqual([enDay, frDay]);
      expect(lines[3]).toBe('');
      // A second run holds every day already: nothing moves.
      const before = await readFile(file, 'utf8');
      expect(await appendPlayed([today, frDay, enDay], file)).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
