// CONTRACT: the memory store answers like the production one. It is the store
// `backend:dev` and every route test runs on, so a rule it spells differently is a rule the
// route tests cannot see — which is why the parity is pinned here rather than assumed.
//
// What this file holds is the parts NO route test reaches: #203's corrective write, which
// the route only issues when a derivation disagrees with the log its append returned — a
// race that a sequential test cannot stage.

import { describe, expect, it } from 'vitest';
import { memoryRoundStore } from './memoryRoundStore';
import { roundMonthPrefix, roundSortKey, roundSortKeyDate, type RoundKey } from './roundStore';

const KEY: RoundKey = { date: '2026-08-21', lang: 'fr' };
const PUBLIC_ID = 'lfd5pqz5pa7zjm5u';
const PUZZLE = 'a1b2c3d4';
const NOW = new Date('2026-08-21T14:00:00.000Z');

async function seeded(progress: number, solved = false) {
  const store = memoryRoundStore();
  await store.append({
    ...KEY,
    publicId: PUBLIC_ID,
    guesses: ['bois'],
    puzzle: PUZZLE,
    progress,
    solved,
    early: false,
    now: NOW,
  });
  return store;
}

const settle = (progress: number, solved = false) => ({
  ...KEY,
  publicId: PUBLIC_ID,
  puzzle: PUZZLE,
  progress,
  solved,
});

describe('memoryRoundStore.settle — the corrective write (#203)', () => {
  it('raises progress, and REFUSES to lower it', async () => {
    const store = await seeded(40);
    await store.settle(settle(75));
    expect((await store.get(KEY, PUBLIC_ID, PUZZLE))?.progress).toBe(75);

    // A settle held up behind the retry backoff, carrying the older log. Last-writer-wins
    // would park 40 on the row for good — there is no later append on a finished round to
    // repair it.
    await store.settle(settle(40));
    expect((await store.get(KEY, PUBLIC_ID, PUZZLE))?.progress).toBe(75);
  });

  it('still records a SOLVE when the percentage is already what it will be', async () => {
    // A solved derivation is exactly 100, so the monotonicity guard can never refuse one.
    const store = await seeded(100);
    await store.settle(settle(100, true));
    expect((await store.get(KEY, PUBLIC_ID, PUZZLE))?.solved).toBe(true);
  });

  it('never writes solved FALSE over a solve another device just recorded', async () => {
    const store = await seeded(100, true);
    await store.settle(settle(100, false));
    expect((await store.get(KEY, PUBLIC_ID, PUZZLE))?.solved).toBe(true);
  });

  it('leaves a RE-PUBLISHED round alone — its summary is about another puzzle', async () => {
    const store = await seeded(40);
    await store.settle({ ...settle(90), puzzle: 'deadbeef' });
    expect((await store.get(KEY, PUBLIC_ID, PUZZLE))?.progress).toBe(40);
  });

  it('is a no-op for a round the store does not hold, and SAYS so', async () => {
    const store = memoryRoundStore();
    await expect(store.settle(settle(90))).resolves.toBe(false);
    expect(await store.get(KEY, PUBLIC_ID, PUZZLE)).toBeNull();
  });

  it('reports whether the asked-for state is now the stored one', async () => {
    // The route claims a solve only when the store confirms it took one — a record of
    // another puzzle, or one already holding better, took nothing.
    const store = await seeded(40);
    await expect(store.settle(settle(75))).resolves.toBe(true);
    await expect(store.settle(settle(40))).resolves.toBe(false);
    await expect(store.settle({ ...settle(90), puzzle: 'deadbeef' })).resolves.toBe(false);
  });
});

// The one INVERSE beside the formatters: both stores read the calendar's date back out of
// the sort key through it, so a future key reorder cannot compile in both while silently
// shifting every date it emits (the #203 reorder is the precedent).
describe('roundSortKeyDate — the sort-key formatters\' inverse', () => {
  it('recovers the exact date a formatter put in', () => {
    const key: RoundKey = { lang: 'fr', date: '2026-08-21' };
    expect(roundSortKeyDate(roundSortKey(key), { lang: 'fr', month: '2026-08' })).toBe(
      '2026-08-21',
    );
  });

  it('agrees with the month prefix: prefix + day digits round-trips', () => {
    const monthKey = { lang: 'en', month: '2026-12' };
    const sortKey = `${roundMonthPrefix(monthKey)}05`;
    expect(roundSortKeyDate(sortKey, monthKey)).toBe('2026-12-05');
  });
});

// CONTRACT (#204, PR-227 review): the active-day transfer's predicate is RECORDED PLAY — a
// stored guess — and the memory store spells it EXACTLY as `planRoundMove` does, on BOTH
// sides. This is the store every route test runs on, so a rule spelled differently here is
// a rule those tests cannot see.
describe('memoryRoundStore.move — what counts as recorded play (#204)', () => {
  const TO = 'aaaaaaaaaaaaaaaa';

  it('MOVES a played round onto an account that holds none', async () => {
    const store = await seeded(40);
    expect(store.move(KEY, PUBLIC_ID, TO)).toEqual({ key: KEY, solved: false });
    expect(await store.get(KEY, PUBLIC_ID, PUZZLE)).toBeNull();
    expect((await store.get(KEY, TO, PUZZLE))?.progress).toBe(40);
  });

  it('BLOCKS a move onto a destination holding play — two real logs have no honest merge', async () => {
    const store = await seeded(40);
    await store.append({
      ...KEY,
      publicId: TO,
      guesses: ['chat'],
      puzzle: PUZZLE,
      progress: 10,
      solved: false,
      early: false,
      now: NOW,
    });
    expect(store.move(KEY, PUBLIC_ID, TO)).toBeNull();
    expect((await store.get(KEY, PUBLIC_ID, PUZZLE))?.progress).toBe(40);
    expect((await store.get(KEY, TO, PUZZLE))?.guesses).toEqual(['chat']);
  });

  it('moves nothing from a source that holds no round', async () => {
    const store = memoryRoundStore();
    expect(store.move(KEY, PUBLIC_ID, TO)).toBeNull();
    expect(await store.get(KEY, TO, PUZZLE)).toBeNull();
  });
});

// The friends board's read (#206): the named players' stored rounds for one daily —
// nothing else, and nobody else's.
describe('memoryRoundStore.getMany — the board read (#206)', () => {
  it('answers only the named players holding a round for THIS daily', async () => {
    const store = await seeded(40);
    const other = 'aaaaaaaaaaaaaaaa';
    await store.append({
      ...KEY,
      publicId: other,
      guesses: ['mer', 'lune'],
      puzzle: 'ffffffffffffffff',
      progress: 10,
      solved: false,
      early: false,
      now: NOW,
    });
    // A round on ANOTHER daily under the same player never answers this day's read.
    await store.append({
      ...KEY,
      date: '2026-08-20',
      publicId: PUBLIC_ID,
      guesses: ['hier'],
      puzzle: PUZZLE,
      progress: 5,
      solved: false,
      early: false,
      now: NOW,
    });

    const rows = await store.getMany(KEY, [PUBLIC_ID, other, 'bbbbbbbbbbbbbbbb']);
    expect(rows).toEqual([
      // The raw log and the tag travel VERBATIM — the board is what interprets them
      // (revision match, dedup); a player with no record simply has no row.
      { publicId: PUBLIC_ID, puzzle: PUZZLE, guesses: ['bois'], progress: 40 },
      { publicId: other, puzzle: 'ffffffffffffffff', guesses: ['mer', 'lune'], progress: 10 },
    ]);
  });
});
