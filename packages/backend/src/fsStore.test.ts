// CONTRACT (issue #17): the local filesystem store is the LOCAL MIRROR of `s3Store`.
// Same selection policy (list the day's dir, keep ".<lang>.json", lexicographically
// first, null when absent) so the SAME handler serves identical results locally and on
// S3. Asserts the spec; a missing day/lang must be a clean null (-> 404), never a throw.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Puzzle } from '@rafaelisinthepan/shared';
import { fsStore } from './fsStore';

const DATE = '2026-06-29';

function puzzle(lang: string, tag: string): Puzzle {
  return {
    lang,
    words: [tag],
    holes: [{ pos: 0, secret: { word: tag, slug: tag }, start: { word: tag, slug: tag }, start_rank: 1 }],
    ranks: {},
  };
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rafael-fsstore-'));
  const dayDir = path.join(root, DATE);
  await mkdir(dayDir, { recursive: true });
  // Two languages for the same day; two French files to prove the lexicographic tiebreak.
  await writeFile(path.join(dayDir, 'bbb.fr.json'), JSON.stringify(puzzle('fr', 'bbb')));
  await writeFile(path.join(dayDir, 'aaa.fr.json'), JSON.stringify(puzzle('fr', 'aaa')));
  await writeFile(path.join(dayDir, 'kitchen.en.json'), JSON.stringify(puzzle('en', 'kitchen')));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fsStore — mirrors s3Store selection', () => {
  it('returns the day\'s puzzle for the requested lang', async () => {
    const p = await fsStore(root).getPuzzle(DATE, 'en');
    expect(p?.lang).toBe('en');
    expect(p?.words).toEqual(['kitchen']);
  });

  it('picks the lexicographically-first match when several exist (determinism)', async () => {
    const p = await fsStore(root).getPuzzle(DATE, 'fr');
    expect(p?.words).toEqual(['aaa']); // aaa.fr.json before bbb.fr.json
  });

  it('returns null (not a throw) when the lang has no puzzle that day', async () => {
    expect(await fsStore(root).getPuzzle(DATE, 'de')).toBeNull();
  });

  it('returns null (not a throw) when the day directory does not exist', async () => {
    expect(await fsStore(root).getPuzzle('1999-01-01', 'fr')).toBeNull();
  });
});
