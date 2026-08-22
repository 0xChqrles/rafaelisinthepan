// CONTRACT: the memory store answers like the production one. It is the store
// `backend:dev` and every route test runs on, so a rule it spells differently is a rule the
// route tests cannot see — which is why the parity is pinned here rather than assumed.
//
// What this file holds is the parts NO route test reaches: #203's corrective write, which
// the route only issues when a derivation disagrees with the log its append returned — a
// race that a sequential test cannot stage.

import { describe, expect, it } from 'vitest';
import { memoryRoundStore } from './memoryRoundStore';
import type { RoundKey } from './roundStore';

const KEY: RoundKey = { date: '2026-08-21', lang: 'fr', mode: 'sentence' };
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
