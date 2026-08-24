// CONTRACT (PR-219 review, P1): localStorage is shared by every tab and persist writes the
// WHOLE partialized snapshot on every set — so a tab must adopt a sibling tab's persisted
// write BEFORE its next own one, or a stale tab's next set of any persisted field (an
// identity adoption's owner tag, a preference) overwrites the active tab's freshly
// persisted outbox or unsent Word run, and a reload then loses the overwritten guesses.
//
// This suite binds the store to a REAL (fake) localStorage before importing it — the
// shared gameStore.test.ts runs without one on purpose — and delivers the sibling tab's
// write through the captured storage listener, the browser's actual cross-tab channel.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageListeners: Array<(event: StorageEvent) => void> = [];

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: () => null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const localStorage = fakeStorage();
vi.stubGlobal('window', {
  localStorage,
  addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
    if (type === 'storage') storageListeners.push(listener);
  },
  removeEventListener: (type: string, listener: (event: StorageEvent) => void) => {
    const index = storageListeners.indexOf(listener);
    if (index >= 0) storageListeners.splice(index, 1);
  },
});

const { GAME_PERSIST_KEY, installGameStoreSync, useGameStore } = await import('./gameStore');

// Another tab persisted its snapshot: rewrite the shared blob the way zustand would, then
// deliver the storage event every OTHER tab receives.
function otherTabPersists(patch: Record<string, unknown>): void {
  const raw = localStorage.getItem(GAME_PERSIST_KEY);
  const blob = raw
    ? (JSON.parse(raw) as { state: Record<string, unknown>; version: number })
    : { state: {}, version: 17 };
  blob.state = { ...blob.state, ...patch };
  localStorage.setItem(GAME_PERSIST_KEY, JSON.stringify(blob));
  for (const listener of [...storageListeners]) {
    listener({ key: GAME_PERSIST_KEY } as StorageEvent);
  }
}

function persistedOutbox(): unknown {
  const raw = localStorage.getItem(GAME_PERSIST_KEY);
  return raw ? (JSON.parse(raw) as { state: { outbox: unknown } }).state.outbox : undefined;
}

beforeEach(() => {
  storageListeners.length = 0;
  localStorage.clear();
  useGameStore.setState({
    identityOwner: null,
    outbox: {},
    wordRounds: {},
    roundLoads: {},
    activeWordKey: null,
    lastLang: null,
  });
});

describe('cross-tab game-blob sync (PR-219 review, P1)', () => {
  it('adopts a sibling tab’s persisted write through the storage event', async () => {
    const stop = installGameStoreSync();
    otherTabPersists({ outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } } });
    await vi.waitFor(() =>
      expect(useGameStore.getState().outbox).toEqual({
        'd:5:fr': { puzzle: 'rev', guesses: ['bois'] },
      }),
    );
    stop();
  });

  it('a set AFTER the adoption cannot erase the sibling tab’s guesses', async () => {
    // The hazard itself: the active tab persisted an outbox; this (stale) tab then sets an
    // unrelated persisted field. Without the sync, persist snapshots THIS tab's empty maps
    // over the shared blob — exactly what an identity adoption's owner-tag write did.
    const stop = installGameStoreSync();
    otherTabPersists({ outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } } });
    await vi.waitFor(() =>
      expect(Object.keys(useGameStore.getState().outbox)).toHaveLength(1),
    );

    useGameStore.getState().setLastLang('fr');
    expect(persistedOutbox()).toEqual({ 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } });
    stop();
  });

  it('without the listener the stale set really does clobber (the guarded hazard)', () => {
    // Pin WHY the sync exists: this is the write pattern the listener defuses. If zustand
    // ever stops snapshotting the whole partialized state per set, this test says the
    // listener may go.
    otherTabPersists({ outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } } });
    useGameStore.getState().setLastLang('en');
    expect(persistedOutbox()).toEqual({});
  });
});
