// CONTRACT (user-decided 2026-09-08): the publish LEDGER is the one record of what has been
// published — one line per sentence day put on S3, carrying the day, the instant, the
// revision, the source, the sentence and the holes as secret / start / start rank. The
// curator's archive reads it and nothing else, so the line's shape is a cross-package fact.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Puzzle } from '@whippin/shared';
import { appendPublished, ledgerEntry, parseLedger, publishLedgerPath } from './ledger';

const puzzle: Puzzle = {
  lang: 'fr',
  words: ['la', 'malheureuse', 'souffrait', 'cruellement.'],
  holes: [
    { pos: 1, secret: { word: 'malheureuse', slug: 'malheureuse' }, start: { word: 'femme', slug: 'femme' }, start_rank: 144 },
  ],
  ranks: { malheureuse: { malheureuse: { word: 'malheureuse', rank: 0 } } },
  source: { kind: 'book', author: 'J-M Machado de Assis', work: 'Mémoires posthumes de Brás Cubas' },
  revision: 'abc123',
};

describe('the publish ledger', () => {
  it('records the day, the instant, the revision, the source, the sentence and the pairs', () => {
    const entry = ledgerEntry(puzzle, '2026-09-08', new Date('2026-09-08T09:00:00Z'));
    expect(entry).toEqual({
      day: '2026-09-08',
      lang: 'fr',
      publishedAt: '2026-09-08T09:00:00.000Z',
      revision: 'abc123',
      source: puzzle.source,
      sentence: 'la malheureuse souffrait cruellement.',
      holes: [{ secret: 'malheureuse', word: 'malheureuse', start: 'femme', startRank: 144 }],
    });
    const { source: _s, ...bare } = puzzle;
    expect('source' in ledgerEntry(bare, '2026-09-08', new Date())).toBe(false);
  });

  it('appends one JSON line per publish and reads them back, skipping a broken line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ledger-'));
    const file = path.join(dir, 'published.jsonl');
    const a = ledgerEntry(puzzle, '2026-09-08', new Date('2026-09-08T09:00:00Z'));
    const b = ledgerEntry({ ...puzzle, revision: 'def456' }, '2026-09-08', new Date('2026-09-08T10:00:00Z'));
    await appendPublished(a, file);
    await appendPublished(b, file);
    const text = await readFile(file, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    expect(parseLedger(text + '{not json\n')).toEqual([a, b]);
  });

  it('lives beside the generation output, whatever the working directory', () => {
    expect(publishLedgerPath()).toMatch(/packages\/generation\/published\.jsonl$/);
  });
});
