import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Puzzle } from '@rafaelisinthepan/shared';
import type { PuzzleStore } from './store';
import { storeKey } from './layout';

// A directory-backed PuzzleStore — the LOCAL mirror of `s3Store`, so the same
// `createHandler` logic (#2) runs on a laptop with no AWS account (issue #17).
//
// The key is deterministic (`layout.storeKey`), so this reads the one file directly
// — no listing. A missing file (no puzzle that day/lang) is a clean null -> 404
// upstream, never a 500.
export function fsStore(root: string): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      try {
        const text = await readFile(path.join(root, storeKey(date, lang)), 'utf8');
        return JSON.parse(text) as Puzzle;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}
