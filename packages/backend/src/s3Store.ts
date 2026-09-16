import { type S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Puzzle } from '@whippin/shared';
import { isNotFound, type PuzzleStore } from './store';
import { decodeSlice } from './slice';
import { sliceKey, storeKey } from './layout';

// S3 layout (shared with the local store via `layout.storeKey`):
// s3://<bucket>/<YYYY-MM-DD>.<lang>.json — the day's puzzle
//
// The key is fully determined by (date, lang), so the Lambda GETs the one object directly —
// no ListObjects scan. A missing object (NoSuchKey / 404) is a clean null -> 404 upstream,
// NOT an error/500.
export function s3Store(client: S3Client, bucket: string): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      try {
        const got = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: storeKey(date, lang) }),
        );
        if (!got.Body) return null;
        return JSON.parse(await got.Body.transformToString()) as Puzzle;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    // #203's slice: the object IS gzip, so it is read as BYTES and decoded — never
    // `transformToString`, which would hand JSON.parse a mangled binary blob.
    async getSlice(date, lang) {
      try {
        const got = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: sliceKey(date, lang) }),
        );
        if (!got.Body) return null;
        return decodeSlice(await got.Body.transformToByteArray());
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}
