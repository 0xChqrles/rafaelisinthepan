import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Puzzle } from '@rafaelisinthepan/shared';
import type { PuzzleStore } from './store';

// A directory-backed PuzzleStore — the LOCAL mirror of `s3Store`, so the same
// `createHandler` logic (#2) runs on a laptop with no AWS account (issue #17).
//
// Selection is byte-for-byte the same policy as `s3Store`: list the day's dir, keep
// names ending ".<lang>.json", take the lexicographically first for determinism, and
// return null when there are none (a clean 404 upstream, never a 500). A missing day
// directory is also null, not an error. See `layout.ts` for the shared key encoding.
export function fsStore(root: string): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      const dir = path.join(root, date);
      const suffix = `.${lang}.json`.toLowerCase();

      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        // No directory for that day -> no puzzle (clean 404), never a 500.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }

      const matches = names
        .filter((n) => n.toLowerCase().endsWith(suffix))
        .sort();
      if (matches.length === 0) return null;

      const text = await readFile(path.join(dir, matches[0]), 'utf8');
      return JSON.parse(text) as Puzzle;
    },
  };
}
