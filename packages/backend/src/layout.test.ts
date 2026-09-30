// CONTRACT (issue #17): how a puzzle is keyed in the store. The key is shared by the
// readers (fsStore/s3Store) and the publish writer, so it must match the day/lang
// contract of #2/#6: a FLAT "<date>.<lang>.json" — fully determined by (game day,
// language), GetObject-addressable, ListObjects-listable by date prefix. Asserts the
// spec, not the implementation.

import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { localStoreRoot, sliceKey, storeKey } from './layout';

describe('storeKey — flat "<date>.<lang>.json"', () => {
  it('joins the game day and lang, no folder, no words', () => {
    expect(storeKey('2026-06-29', 'fr')).toBe('2026-06-29.fr.json');
  });

  it('is one key per (date, lang): another language is another key', () => {
    expect(storeKey('2026-06-29', 'en')).not.toBe(storeKey('2026-06-29', 'fr'));
  });
});

// CONTRACT (#203): the derivation slice sits BESIDE the puzzle, in the same flat layout,
// and its key says it is gzip — the object IS compressed bytes, so a reader that decodes
// it as text hands JSON.parse a mangled blob.
describe('sliceKey — the derivation slice, beside the sentence puzzle', () => {
  it('is one deterministic key per (date, lang), distinct from the puzzle\'s', () => {
    expect(sliceKey('2026-06-29', 'fr')).toBe('2026-06-29.fr.slice.json.gz');
    expect(sliceKey('2026-06-29', 'fr')).not.toBe(storeKey('2026-06-29', 'fr'));
    expect(sliceKey('2026-06-29', 'en')).not.toBe(sliceKey('2026-06-29', 'fr'));
  });
});

// CONTRACT (#17): every local tool — `publish`, `serve`, `inventory`, `board:seed` — reads
// the store root ONE way, so the same PUZZLE_STORE can never send the writer and the readers
// to different directories. A RELATIVE value is read against the directory the command was
// INVOKED from (INIT_CWD, which pnpm sets), not the package dir pnpm runs the script in.
describe('localStoreRoot — one root for every local tool', () => {
  it('resolves a relative PUZZLE_STORE against the directory the command was invoked from', () => {
    expect(localStoreRoot(undefined, { PUZZLE_STORE: './tmp-store', INIT_CWD: '/repo' })).toBe(
      path.resolve('/repo', 'tmp-store'),
    );
  });

  it('falls back to the working directory when nothing names the invocation directory', () => {
    expect(localStoreRoot(undefined, { PUZZLE_STORE: 'tmp-store' })).toBe(
      path.resolve(process.cwd(), 'tmp-store'),
    );
  });

  it('leaves an absolute PUZZLE_STORE where it points', () => {
    expect(localStoreRoot(undefined, { PUZZLE_STORE: '/var/store', INIT_CWD: '/repo' })).toBe(
      path.resolve('/var/store'),
    );
  });

  it("lets publish's --store win over the environment, resolved the same way", () => {
    expect(localStoreRoot('other', { PUZZLE_STORE: './tmp-store', INIT_CWD: '/repo' })).toBe(
      path.resolve('/repo', 'other'),
    );
  });

  it('defaults to packages/backend/.local-store when none is named, whatever the directory', () => {
    const fallback = localStoreRoot(undefined, { INIT_CWD: '/repo' });
    expect(fallback).toMatch(/packages\/backend\/\.local-store$/);
    expect(localStoreRoot(undefined, {})).toBe(fallback);
    expect(localStoreRoot(undefined, { PUZZLE_STORE: '', INIT_CWD: '/elsewhere' })).toBe(fallback);
  });
});
