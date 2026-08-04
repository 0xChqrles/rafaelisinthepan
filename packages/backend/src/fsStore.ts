import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Puzzle, WordPuzzle } from '@whippin/shared';
import type { PuzzleStore } from './store';
import { storeKey, type PuzzleMode } from './layout';

// A directory-backed PuzzleStore — the LOCAL mirror of `s3Store`, so the same
// `createHandler` logic (#2) runs on a laptop with no AWS account (issue #17).
//
// The key is deterministic (`layout.storeKey`), so this reads the one file directly
// — no listing. A missing file (no puzzle that day/lang) is a clean null -> 404
// upstream, never a 500.
export function fsStore(root: string): PuzzleStore {
  async function read(date: string, lang: string, mode: PuzzleMode): Promise<unknown | null> {
    try {
      const text = await readFile(path.join(root, storeKey(date, lang, mode)), 'utf8');
      return JSON.parse(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  return {
    async getPuzzle(date, lang) {
      return (await read(date, lang, 'sentence')) as Puzzle | null;
    },
    async getWordPuzzle(date, lang) {
      return (await read(date, lang, 'word')) as WordPuzzle | null;
    },
  };
}
