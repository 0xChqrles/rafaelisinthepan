// CONTRACT (issue #17): the local filesystem store is the LOCAL MIRROR of `s3Store`.
// Same key (`layout.storeKey`, "<date>.<lang>.json") read directly, so the SAME handler
// serves identical results locally and on S3. A missing day/lang must be a clean null
// (-> 404), never a throw.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Puzzle } from '@whippin/shared';
import { fsStore } from './fsStore';
import { storeKey } from './layout';

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
  root = await mkdtemp(path.join(tmpdir(), 'whippin-fsstore-'));
  // One puzzle per (date, lang), keyed flat — two languages share the same day.
  await writeFile(path.join(root, storeKey(DATE, 'fr')), JSON.stringify(puzzle('fr', 'vent')));
  await writeFile(path.join(root, storeKey(DATE, 'en')), JSON.stringify(puzzle('en', 'kitchen')));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fsStore — mirrors s3Store, reads the flat key directly', () => {
  it('returns the day\'s puzzle for the requested lang', async () => {
    expect((await fsStore(root).getPuzzle(DATE, 'en'))?.words).toEqual(['kitchen']);
    expect((await fsStore(root).getPuzzle(DATE, 'fr'))?.words).toEqual(['vent']);
  });

  it('returns null (not a throw) when the lang has no puzzle that day', async () => {
    expect(await fsStore(root).getPuzzle(DATE, 'de')).toBeNull();
  });

  it('returns null (not a throw) when no file exists for the day', async () => {
    expect(await fsStore(root).getPuzzle('1999-01-01', 'fr')).toBeNull();
  });
});
