import { type S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Puzzle, WordPuzzle } from '@whippin/shared';
import type { PuzzleStore } from './store';
import { storeKey, type PuzzleMode } from './layout';

// A missing S3 object surfaces as NoSuchKey (or a bare 404 status). Treat any of these
// as "no puzzle" -> null, never a throw/500.
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

// S3 layout (shared with the local store via `layout.storeKey`):
// s3://<bucket>/<YYYY-MM-DD>.<lang>.json          — the sentence puzzle
// s3://<bucket>/<YYYY-MM-DD>.<lang>.word.json     — Word mode's #154 artifact (#156)
//
// The key is fully determined by (date, lang, mode), so the Lambda GETs the one object
// directly — no ListObjects scan. A missing object (NoSuchKey / 404) is a clean null
// -> 404 upstream, NOT an error/500.
export function s3Store(client: S3Client, bucket: string): PuzzleStore {
  async function read(date: string, lang: string, mode: PuzzleMode): Promise<unknown | null> {
    try {
      const got = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: storeKey(date, lang, mode) }),
      );
      if (!got.Body) return null;
      return JSON.parse(await got.Body.transformToString());
    } catch (err) {
      if (isNotFound(err)) return null;
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
