// CONTRACT (issue #17): the local filesystem store is the LOCAL MIRROR of `s3Store`.
// Same key (`layout.storeKey`, "<date>.<lang>.json") read directly, so the SAME handler
// serves identical results locally and on S3. A missing day/lang must be a clean null
// (-> 404), never a throw.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

// CONTRACT (issue #42): `version` is a CONTENT token — it changes iff the stored bytes
// change, and is null when there is no puzzle. Locally it must be the MD5 of the file
// bytes, byte-identical to the S3 ETag for the same single-part object, so `backend:dev`
// version-busts exactly like production.
describe('fsStore.version — content-addressed cache-busting token', () => {
  it('is the MD5 of the stored bytes (matches the S3 ETag for the same object)', async () => {
    const bytes = await readFile(path.join(root, storeKey(DATE, 'fr')));
    const expected = createHash('md5').update(bytes).digest('hex');
    expect(await fsStore(root).version(DATE, 'fr')).toBe(expected);
  });

  it('differs across puzzles with different content', async () => {
    const fr = await fsStore(root).version(DATE, 'fr');
    const en = await fsStore(root).version(DATE, 'en');
    expect(fr).not.toBe(en);
  });

  it('is stable when the content is unchanged, and changes when it changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'whippin-fsver-'));
    try {
      const key = storeKey(DATE, 'fr');
      await writeFile(path.join(dir, key), JSON.stringify(puzzle('fr', 'vent')));
      const v1 = await fsStore(dir).version(DATE, 'fr');
      // Rewriting identical bytes must NOT churn the version (no spurious cache-bust).
      await writeFile(path.join(dir, key), JSON.stringify(puzzle('fr', 'vent')));
      expect(await fsStore(dir).version(DATE, 'fr')).toBe(v1);
      // A real content change (a republish/correction) must yield a new version.
      await writeFile(path.join(dir, key), JSON.stringify(puzzle('fr', 'orage')));
      expect(await fsStore(dir).version(DATE, 'fr')).not.toBe(v1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null (not a throw) when there is no puzzle for that day/lang', async () => {
    expect(await fsStore(root).version(DATE, 'de')).toBeNull();
    expect(await fsStore(root).version('1999-01-01', 'fr')).toBeNull();
  });
});
