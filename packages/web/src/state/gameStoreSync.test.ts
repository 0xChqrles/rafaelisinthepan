// CONTRACT (PR-219 reviews, P1): localStorage is shared by every tab and persist writes
// the WHOLE partialized snapshot on every set. TWO halves keep a lagging tab from
// flattening a sibling's freshly persisted entries:
//   - WRITE-TIME: every persisted write merges over the blob as stored RIGHT THEN —
//     this tab's value for keys its own actions touched, the stored value for every
//     other — because the storage EVENT is queued asynchronously by spec, so any set
//     landing before the event would otherwise snapshot stale maps over the sibling's
//     write (the round-3 finding);
//   - READ-TIME: the storage event still rehydrates, so this tab's memory tracks the
//     shared blob and its own UI can show what a sibling played.
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

const { GAME_PERSIST_KEY, installGameStoreSync, resetTouchedKeys, useGameStore } =
  await import('./gameStore');

// Another tab persisted its snapshot: rewrite the shared blob the way zustand would. The
// EVENT is deliberately separate — the browser queues it, and the round-3 finding is
// precisely a set landing in that gap.
function otherTabWrites(patch: Record<string, unknown>): void {
  const raw = localStorage.getItem(GAME_PERSIST_KEY);
  const blob = raw
    ? (JSON.parse(raw) as { state: Record<string, unknown>; version: number })
    : { state: {}, version: 17 };
  blob.state = { ...blob.state, ...patch };
  localStorage.setItem(GAME_PERSIST_KEY, JSON.stringify(blob));
}

function otherTabPersists(patch: Record<string, unknown>): void {
  otherTabWrites(patch);
  for (const listener of [...storageListeners]) {
    listener({ key: GAME_PERSIST_KEY } as StorageEvent);
  }
}

function persistedField(field: string): unknown {
  const raw = localStorage.getItem(GAME_PERSIST_KEY);
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown> }).state[field] : undefined;
}

function persistedOutbox(): unknown {
  const raw = localStorage.getItem(GAME_PERSIST_KEY);
  return raw ? (JSON.parse(raw) as { state: { outbox: unknown } }).state.outbox : undefined;
}

beforeEach(() => {
  storageListeners.length = 0;
  localStorage.clear();
  resetTouchedKeys();
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

  it('a set BEFORE the event arrives cannot flatten the sibling tab’s entry', () => {
    // THE round-3 scenario: the sibling persisted a guess, the browser has not delivered
    // the storage event yet (it is queued asynchronously by spec), and this tab performs a
    // set. The WRITE-TIME merge reads the blob as stored right then, so the sibling's
    // entry survives a snapshot this tab's stale memory knows nothing about. No event is
    // fired here on purpose.
    otherTabWrites({ outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } } });
    useGameStore.getState().setLastLang('en');
    expect(persistedOutbox()).toEqual({ 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } });
    // …and the scalar this tab actually set still landed.
    expect(persistedField('lastLang')).toBe('en');
  });

  it('this tab’s OWN key wins the merge — its guess is what persists', () => {
    // A key this tab's actions touched is its own to write: the merge must not let a
    // sibling's older copy of the SAME round overwrite the guess just typed here.
    otherTabWrites({ outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['mer'] } } });
    useGameStore.setState({ outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['mer'] } } });
    useGameStore.getState().appendOutbox('d:5:fr', 'rev', 'bois');
    expect(persistedOutbox()).toEqual({ 'd:5:fr': { puzzle: 'rev', guesses: ['mer', 'bois'] } });
  });

  it('a deliberate DELETION of a touched key sticks', () => {
    // An acknowledged outbox is removed by this tab's own action; the merge must not
    // resurrect the stored copy (an absent touched key is a deletion, not ignorance).
    useGameStore.getState().appendOutbox('d:5:fr', 'rev', 'bois');
    otherTabWrites({ outbox: { 'd:5:fr': { puzzle: 'rev', guesses: ['bois'] } } });
    useGameStore.getState().setOutbox('d:5:fr', 'rev', []);
    expect(persistedOutbox()).toEqual({});
  });

  it('one-time flags merge monotonically — a stale false never unsets a true', () => {
    otherTabWrites({ sentenceRulesSeen: true });
    useGameStore.getState().setLastLang('fr');
    const raw = localStorage.getItem(GAME_PERSIST_KEY);
    expect((JSON.parse(raw as string) as { state: { sentenceRulesSeen: boolean } }).state
      .sentenceRulesSeen).toBe(true);
  });
});
