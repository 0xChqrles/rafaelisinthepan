// CONTRACT: the S3 store is the PRODUCTION half of what `fsStore.test.ts` pins for the local
// mirror. Same keys (`layout.storeKey` / `layout.sliceKey`) read directly, and a missing
// object is a clean null (-> the day-addressed 404) — or `false` from the existence probe —
// never a throw. Anything ELSE throws: a throttle or a 5xx is an error upstream, never "no
// puzzle today".

import { describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Puzzle } from '@whippin/shared';
import { sliceKey, storeKey } from './layout';
import { s3Store } from './s3Store';
import { encodeSlice, type PuzzleSlice } from './slice';

const DATE = '2026-06-29';
const BUCKET = 'puzzles';

const PUZZLE: Puzzle = {
  lang: 'fr',
  revision: 'f6frvent',
  words: ['vent'],
  holes: [{ pos: 0, secret: { word: 'vent', slug: 'vent' }, start: { word: 'air', slug: 'air' }, start_rank: 2 }],
  ranks: {},
};
const SLICE: PuzzleSlice = {
  lang: 'fr',
  revision: 'abc123',
  holes: { vent: { n: 4, startRank: 2, ranks: { vent: 0 } } },
};

// A bucket holding the objects given, answering everything else the way S3 does.
function bucket(objects: Record<string, { text?: string; bytes?: Uint8Array }>) {
  const transformToString = vi.fn(async (key: string) => objects[key].text ?? '');
  const transformToByteArray = vi.fn(async (key: string) => objects[key].bytes ?? new Uint8Array());
  const send = vi.fn(async (command: GetObjectCommand | HeadObjectCommand) => {
    const key = command.input.Key ?? '';
    if (!(key in objects)) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    return {
      Body: {
        transformToString: () => transformToString(key),
        transformToByteArray: () => transformToByteArray(key),
      },
    };
  });
  return { send, transformToString, transformToByteArray, store: s3Store({ send } as unknown as S3Client, BUCKET) };
}

// A bucket whose every read fails with `error`.
function failing(error: Error) {
  const send = vi.fn(async () => {
    throw error;
  });
  return s3Store({ send } as unknown as S3Client, BUCKET);
}

const s3Error = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error(name), {
    name,
    ...(httpStatusCode === undefined ? {} : { $metadata: { httpStatusCode } }),
  });

describe('s3Store — reads the flat key directly', () => {
  it('GETs the day\'s puzzle at its store key, in the bucket', async () => {
    const { send, store } = bucket({ [storeKey(DATE, 'fr')]: { text: JSON.stringify(PUZZLE) } });
    await expect(store.getPuzzle(DATE, 'fr')).resolves.toEqual(PUZZLE);
    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: '2026-06-29.fr.json' });
  });

  it('GETs the #203 slice at its own key and decodes it from BYTES, never a string', async () => {
    const { send, transformToString, transformToByteArray, store } = bucket({
      [sliceKey(DATE, 'fr')]: { bytes: new Uint8Array(encodeSlice(SLICE)) },
    });
    await expect(store.getSlice(DATE, 'fr')).resolves.toEqual(SLICE);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: '2026-06-29.fr.slice.json.gz' });
    // The object IS gzip: read as text it reaches the decoder as a mangled blob.
    expect(transformToByteArray).toHaveBeenCalledTimes(1);
    expect(transformToString).not.toHaveBeenCalled();
  });

  it('returns null (not a throw) for an object that is not there', async () => {
    const { store } = bucket({ [storeKey(DATE, 'fr')]: { text: JSON.stringify(PUZZLE) } });
    expect(await store.getPuzzle(DATE, 'en')).toBeNull();
    expect(await store.getPuzzle('1999-01-01', 'fr')).toBeNull();
    // A missing slice IS a missing puzzle upstream — a clean null, never a throw.
    expect(await store.getSlice(DATE, 'fr')).toBeNull();
  });

  it('HEADs the puzzle\'s store key to probe existence, never downloading the body', async () => {
    const { send, transformToString, transformToByteArray, store } = bucket({
      [storeKey(DATE, 'fr')]: { text: JSON.stringify(PUZZLE) },
    });
    await expect(store.hasPuzzle(DATE, 'fr')).resolves.toBe(true);
    await expect(store.hasPuzzle(DATE, 'en')).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls) expect(command).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, Key: '2026-06-29.fr.json' });
    expect(transformToString).not.toHaveBeenCalled();
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it.each([
    ['NoSuchKey', s3Error('NoSuchKey')],
    ['NotFound', s3Error('NotFound')],
    ['a bare 404 status', s3Error('UnknownError', 404)],
  ])('reads %s as missing, for the puzzle, the slice and the probe alike', async (_label, error) => {
    expect(await failing(error).getPuzzle(DATE, 'fr')).toBeNull();
    expect(await failing(error).getSlice(DATE, 'fr')).toBeNull();
    expect(await failing(error).hasPuzzle(DATE, 'fr')).toBe(false);
  });

  it.each([
    ['a throttle', s3Error('SlowDown', 503)],
    ['a server error', s3Error('InternalError', 500)],
    ['a denied read', s3Error('AccessDenied', 403)],
  ])('THROWS on %s — only a missing object is a null', async (_label, error) => {
    await expect(failing(error).getPuzzle(DATE, 'fr')).rejects.toBe(error);
    await expect(failing(error).getSlice(DATE, 'fr')).rejects.toBe(error);
    await expect(failing(error).hasPuzzle(DATE, 'fr')).rejects.toBe(error);
  });
});
