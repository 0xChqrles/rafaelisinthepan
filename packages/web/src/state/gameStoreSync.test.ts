// CONTRACT (PR-219 final review, P1): every persisted change is a semantic mutation
// executed inside ONE IndexedDB readwrite transaction. Transactions touching the state
// store serialize origin-wide, so each mutation reads the latest committed value — never a
// tab's lagging Zustand snapshot. These tests use two independent database connections, the
// same topology as two tabs, and pin the races the retired localStorage merge could not fix.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB } from 'idb';
import {
  GAME_DATABASE_NAME,
  GameStateDatabase,
  type StoredGameState,
} from './gamePersistence';
import {
  applyGameMutation,
  GAME_PERSIST_VERSION,
  initialPersistedState,
  type GameMutation,
  type IdentityOwner,
  type PersistedState,
} from './gameStore';
import { runMs } from '../game/wordGame';

const A: IdentityOwner = { accountId: 'a'.repeat(16), deviceId: 'd'.repeat(16) };
const B: IdentityOwner = { accountId: 'b'.repeat(16), deviceId: 'e'.repeat(16) };
const REV = 'a1b2c3d4e5f60718';
const T0 = 1_700_000_000_000;

let serial = 0;
let databaseName = '';
let databases: GameStateDatabase<PersistedState>[] = [];

function tab(): GameStateDatabase<PersistedState> {
  const database = new GameStateDatabase<PersistedState>(databaseName);
  databases.push(database);
  return database;
}

async function mutate(
  database: GameStateDatabase<PersistedState>,
  mutation: GameMutation,
): Promise<PersistedState> {
  const stored = await database.update((current) => ({
    version: GAME_PERSIST_VERSION,
    state: applyGameMutation(current?.state ?? initialPersistedState(), mutation).state,
  }));
  return stored.state;
}

async function seed(
  database: GameStateDatabase<PersistedState>,
  state: PersistedState,
): Promise<void> {
  await database.update(() => ({ version: GAME_PERSIST_VERSION, state }));
}

async function read(database: GameStateDatabase<PersistedState>): Promise<PersistedState> {
  return ((await database.read()) as StoredGameState<PersistedState>).state;
}

beforeEach(() => {
  serial += 1;
  databaseName = `whippin-game-test-${serial}`;
  databases = [];
});

afterEach(async () => {
  await Promise.all(databases.map((database) => database.close()));
  await deleteDB(databaseName);
});

describe('transactional cross-tab game persistence', () => {
  it('serializes simultaneous writes from independent tabs without losing either key', async () => {
    const first = tab();
    const second = tab();
    await seed(first, { ...initialPersistedState(), identityOwner: A });

    await Promise.all([
      mutate(first, {
        type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'bois', expectedOwner: A,
      }),
      mutate(second, {
        type: 'appendOutbox', key: 'd:6:fr', puzzle: REV, typed: 'mer', expectedOwner: A,
      }),
    ]);

    expect((await read(first)).outbox).toEqual({
      'd:5:fr': { puzzle: REV, guesses: ['bois'] },
      'd:6:fr': { puzzle: REV, guesses: ['mer'] },
    });
  });

  it('serializes simultaneous appends to the SAME sentence round', async () => {
    const first = tab();
    const second = tab();
    await seed(first, { ...initialPersistedState(), identityOwner: A });

    await Promise.all([
      mutate(first, {
        type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'bois', expectedOwner: A,
      }),
      mutate(second, {
        type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'foret', expectedOwner: A,
      }),
    ]);

    expect([...(await read(second)).outbox['d:5:fr']!.guesses].sort()).toEqual(['bois', 'foret']);
  });

  it('an old writer’s unrelated preference change cannot revert a sibling’s later guess', async () => {
    const staleTab = tab();
    const activeTab = tab();
    await seed(staleTab, { ...initialPersistedState(), identityOwner: A });
    await mutate(staleTab, {
      type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'old', expectedOwner: A,
    });
    await mutate(activeTab, {
      type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'fresh', expectedOwner: A,
    });

    await mutate(staleTab, { type: 'setLastLang', lang: 'en' });

    const state = await read(activeTab);
    expect(state.outbox['d:5:fr']?.guesses).toEqual(['old', 'fresh']);
    expect(state.lastLang).toBe('en');
  });

  it('an owner transition clears sibling-only state from the latest committed snapshot', async () => {
    const staleTab = tab();
    const activeTab = tab();
    await seed(staleTab, { ...initialPersistedState(), identityOwner: A });
    await mutate(activeTab, {
      type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'private-a', expectedOwner: A,
    });
    await mutate(activeTab, {
      type: 'ensureWordRound', key: 'w:5:fr', word: 'phare', expectedOwner: A,
    });

    await mutate(staleTab, {
      type: 'reconcileIdentity',
      expectedOwner: A,
      identity: B,
      pendingBootstrap: false,
    });

    expect(await read(activeTab)).toMatchObject({ identityOwner: B, outbox: {}, wordRounds: {} });
  });

  it('an old identity’s delayed mutation cannot write into the replacement identity', async () => {
    const staleTab = tab();
    const activeTab = tab();
    await seed(staleTab, { ...initialPersistedState(), identityOwner: A });
    await mutate(activeTab, {
      type: 'reconcileIdentity',
      expectedOwner: A,
      identity: B,
      pendingBootstrap: false,
    });

    await mutate(staleTab, {
      type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'late-a', expectedOwner: A,
    });

    expect(await read(activeTab)).toMatchObject({ identityOwner: B, outbox: {} });
  });

  it('an acknowledgement removes its snapshot while preserving a concurrent append', async () => {
    const writer = tab();
    const sibling = tab();
    await seed(writer, {
      ...initialPersistedState(),
      identityOwner: A,
      outbox: { 'd:5:fr': { puzzle: REV, guesses: ['sent'] } },
    });

    await Promise.all([
      mutate(writer, {
        type: 'settleOutbox',
        key: 'd:5:fr',
        puzzle: REV,
        before: ['sent'],
        after: [],
        expectedOwner: A,
      }),
      mutate(sibling, {
        type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'new', expectedOwner: A,
      }),
    ]);

    expect((await read(writer)).outbox['d:5:fr']?.guesses).toEqual(['new']);
  });

  it('retention deletions are committed against the full shared map and stay deleted', async () => {
    const writer = tab();
    const sibling = tab();
    const outbox: PersistedState['outbox'] = {};
    for (let day = 1; day <= 800; day += 1) {
      outbox[`d:${day}:fr`] = { puzzle: REV, guesses: [`g${day}`] };
    }
    await seed(writer, { ...initialPersistedState(), identityOwner: A, outbox });

    await mutate(sibling, {
      type: 'appendOutbox', key: 'd:801:fr', puzzle: REV, typed: 'new', expectedOwner: A,
    });
    await mutate(writer, { type: 'setLastLang', lang: 'fr' });

    const committed = await read(writer);
    expect(Object.keys(committed.outbox)).toHaveLength(800);
    expect(committed.outbox['d:1:fr']).toBeUndefined();
    expect(committed.outbox['d:801:fr']).toBeDefined();
  });

  it('the placeholder seed is first-write-wins across simultaneous tabs', async () => {
    const first = tab();
    const second = tab();

    await Promise.all([
      mutate(first, { type: 'ensureLocalSeed', seed: 'a'.repeat(16), at: '2026-08-01T00:00:00.000Z' }),
      mutate(second, { type: 'ensureLocalSeed', seed: 'b'.repeat(16), at: '2026-08-01T00:00:00.000Z' }),
    ]);

    const established = (await read(first)).localSeed;
    expect(established === 'a'.repeat(16) || established === 'b'.repeat(16)).toBe(true);
    await mutate(first, { type: 'ensureLocalSeed', seed: 'c'.repeat(16), at: '2026-08-01T00:00:00.000Z' });
    expect((await read(second)).localSeed).toBe(established);
  });

  it('serializes same-run Word guesses and recomputes the cache from the committed log', async () => {
    const first = tab();
    const second = tab();
    await seed(first, {
      ...initialPersistedState(),
      identityOwner: A,
      wordRounds: {
        'w:5:fr': {
          word: 'phare',
          startedAt: T0,
          deadline: T0 + runMs(0),
          tried: [],
          claimed: 0,
        },
      },
    });
    const replay = (tried: string[]) => ({ claimed: tried.length, bonus: tried.length * 3 });

    await Promise.all([
      mutate(first, {
        type: 'recordWordGuess',
        key: 'w:5:fr',
        word: 'phare',
        typed: 'mer',
        now: T0,
        replay,
        expectedOwner: A,
      }),
      mutate(second, {
        type: 'recordWordGuess',
        key: 'w:5:fr',
        word: 'phare',
        typed: 'sel',
        now: T0,
        replay,
        expectedOwner: A,
      }),
    ]);

    const round = (await read(first)).wordRounds['w:5:fr'];
    expect(round).toMatchObject({
      claimed: 2,
      deadline: T0 + runMs(6),
    });
    expect([...(round?.tried ?? [])].sort()).toEqual(['mer', 'sel']);
  });

  it('rejects delayed Word writes for a word a sibling already replaced', async () => {
    const staleTab = tab();
    const activeTab = tab();
    await seed(staleTab, {
      ...initialPersistedState(),
      identityOwner: A,
      wordRounds: {
        'w:5:fr': {
          word: 'phare',
          startedAt: T0,
          deadline: T0 + runMs(0),
          tried: [],
          claimed: 0,
        },
      },
    });
    await mutate(activeTab, {
      type: 'ensureWordRound', key: 'w:5:fr', word: 'ocean', expectedOwner: A,
    });

    await mutate(staleTab, {
      type: 'recordWordGuess',
      key: 'w:5:fr',
      word: 'phare',
      typed: 'mer',
      now: T0,
      replay: (tried) => ({ claimed: tried.length, bonus: 0 }),
      expectedOwner: A,
    });
    await mutate(staleTab, {
      type: 'settleWordRun',
      key: 'w:5:fr',
      word: 'phare',
      claimed: 7,
      now: T0,
      expectedOwner: A,
    });

    expect((await read(activeTab)).wordRounds['w:5:fr']).toEqual({
      word: 'ocean',
      startedAt: null,
      deadline: null,
      tried: [],
      claimed: 0,
    });
  });
});

describe('live store wiring', () => {
  it('commits against sibling state before a queued notification and later refreshes the cache', async () => {
    await deleteDB(GAME_DATABASE_NAME);
    const listeners = new Set<(event: StorageEvent) => void>();
    const values = new Map<string, string>();
    let deliverSignals = true;
    const emit = (key: string) => {
      for (const listener of [...listeners]) listener({ key } as StorageEvent);
    };
    const localStorage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: () => null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => {
        values.set(key, value);
        if (deliverSignals) queueMicrotask(() => emit(key));
      },
    } satisfies Storage;
    vi.stubGlobal('window', {
      localStorage,
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === 'storage') listeners.delete(listener);
      },
    });
    // Exercise the fallback too: it has the same queued-event semantics as the browser's
    // identity storage channel and must remain only a cache invalidation mechanism.
    vi.stubGlobal('BroadcastChannel', undefined);

    let stopFirst = () => {};
    let stopSecond = () => {};
    try {
      vi.resetModules();
      const first = await import('./gameStore');
      await first.hydrateGameStore();
      first.reconcileGameStateIdentity(A);
      await first.flushGameStorePersistence();
      stopFirst = first.installGameStoreSync();

      vi.resetModules();
      const second = await import('./gameStore');
      await second.hydrateGameStore();
      second.reconcileGameStateIdentity(A);
      await second.flushGameStorePersistence();
      stopSecond = second.installGameStoreSync();

      second.useGameStore.getState().setLastLang('fr');
      await second.flushGameStorePersistence();
      await vi.waitFor(() => expect(first.useGameStore.getState().lastLang).toBe('fr'));

      // Hold back the event exactly as the Web Storage spec permits. `second` now has a
      // genuinely stale cache when its next actions run.
      deliverSignals = false;
      first.useGameStore.getState().appendOutbox('d:5:fr', REV, 'bois');
      first.useGameStore.getState().setLastLang('en');
      await first.flushGameStorePersistence();
      expect(second.useGameStore.getState()).toMatchObject({ outbox: {}, lastLang: 'fr' });

      // This is an explicit `fr` intent even though the stale cache already says `fr`.
      // Its transaction must read `en`, restore `fr`, and preserve the sibling outbox.
      second.useGameStore.getState().setLastLang('fr');
      await second.flushGameStorePersistence();
      const probe = new GameStateDatabase<PersistedState>(GAME_DATABASE_NAME);
      const committed = await probe.read();
      await probe.close();
      expect(committed?.state).toMatchObject({
        identityOwner: A,
        lastLang: 'fr',
        outbox: { 'd:5:fr': { puzzle: REV, guesses: ['bois'] } },
      });
      deliverSignals = true;
      emit('whippin-game-sync-signal');

      await vi.waitFor(() => {
        expect(first.useGameStore.getState().lastLang).toBe('fr');
        expect(second.useGameStore.getState().outbox).toEqual({
          'd:5:fr': { puzzle: REV, guesses: ['bois'] },
        });
      });
    } finally {
      stopSecond();
      stopFirst();
      vi.unstubAllGlobals();
      await deleteDB(GAME_DATABASE_NAME);
    }
  });
});
