import { type S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Puzzle } from '@whippin/shared';
import type { PuzzleStore } from './store';
import { storeKey } from './layout';

// A missing S3 object surfaces as NoSuchKey (GetObject) or NotFound (HeadObject); both
// carry a 404 status. Treat any of these as "no puzzle" -> null, never a throw/500.
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

// S3 layout (shared with the local store via `layout.storeKey`):
// s3://<bucket>/<YYYY-MM-DD>.<lang>.json
//
// The key is fully determined by (date, lang), so the Lambda GETs the one object
// directly — no ListObjects scan. A missing object (NoSuchKey / 404) is a clean null
// -> 404 upstream, NOT an error/500.
export function s3Store(client: S3Client, bucket: string): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      try {
        const got = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: storeKey(date, lang) }),
        );
        if (!got.Body) return null;
        const text = await got.Body.transformToString();
        return JSON.parse(text) as Puzzle;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    // The version is the object's ETag — which, for our single-part PutObject into an
    // SSE-S3 bucket, IS the MD5 of the body (issue #42). HeadObject reads it from metadata
    // WITHOUT downloading the body, and needs only s3:GetObject (already granted by
    // bucket.grantRead). Strip S3's surrounding quotes so it's a clean URL token.
    async version(date, lang) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: storeKey(date, lang) }),
        );
        return head.ETag ? head.ETag.replace(/"/g, '') : null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}
