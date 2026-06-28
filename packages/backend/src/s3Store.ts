import {
  type S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import type { Puzzle } from '@rafaelisinthepan/shared';
import type { PuzzleStore } from './store';

// S3 layout (see issue #2): s3://<bucket>/<YYYY-MM-DD>/<w1>-<w2>-<w3>.<lang>.json
//
// The Lambda knows the date and lang but NOT the puzzle's words, so it lists the
// day's prefix and picks the object whose key ends with ".<lang>.json". Exactly one
// is expected per date+lang; if several exist we take the lexicographically first for
// determinism. Zero matches -> null (a clean 404 upstream).
export function s3Store(client: S3Client, bucket: string): PuzzleStore {
  return {
    async getPuzzle(date, lang) {
      const prefix = `${date}/`;
      const suffix = `.${lang}.json`.toLowerCase();

      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => !!k && k.toLowerCase().endsWith(suffix))
        .sort();
      if (keys.length === 0) return null;

      const got = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: keys[0] }),
      );
      if (!got.Body) return null;
      const text = await got.Body.transformToString();
      return JSON.parse(text) as Puzzle;
    },
  };
}
