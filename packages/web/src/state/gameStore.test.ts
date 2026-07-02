// CONTRACT: the day-keyed round store (packages/web/src/state/gameStore.ts). Rounds are
// held in a MAP keyed by roundKey = (dayNumber, language), so:
//   - a NEW day prunes the previous day's rounds (a new day never bleeds yesterday's in);
//   - switching LANGUAGE keeps BOTH rounds — coming back restores the in-progress one
//     (drives the language selector's per-language status + no-confirmation switching);
//   - the SAME key rehydrates the stored progress untouched (mid-round reload);
//   - score = number of UNIQUE valid tries, deduped by folded slug;
//   - an improved hole swaps in the closer word + lower rank; solved holes stay locked;
//   - progress is cached per round for the selector badge;
//   - lastLang remembers the last valid language (seeds the `/` redirect).

import { describe, it, expect, beforeEach } from 'vitest';
import { useGameStore, roundKeyForDay } from './gameStore';
import type { RuntimeHole } from '@whippin/shared';

const initial = useGameStore.getState();

// Two holes at their start ranks — the fresh state a round begins from.
function freshHoles(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'foret', word: 'bois', rank: 87, startRank: 87 },
    { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
  ];
}

// The active round (rounds[activeKey]) — what the game screen reads.
function activeRound() {
  const s = useGameStore.getState();
  return s.activeKey ? s.rounds[s.activeKey] : undefined;
}

beforeEach(() => {
  // Reset to a pristine store between tests (replace, keeping the actions).
  useGameStore.setState({ rounds: {}, lastLang: null, activeKey: null }, false);
});

describe('roundKeyForDay', () => {
  it('is (day, lang) and matches the documented format', () => {
    expect(roundKeyForDay(5, 'fr')).toBe('d:5:fr');
    expect(roundKeyForDay(6, 'en')).toBe('d:6:en');
  });
});

describe('ensureRound — day/language keying', () => {
  it('initializes a fresh round for a brand-new key and makes it active', () => {
    useGameStore.getState().ensureRound('d:5:fr', freshHoles());
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('d:5:fr');
    expect(s.rounds['d:5:fr']).toEqual({
      holes: freshHoles(),
      guessCount: 0,
      tried: [],
      progress: 0,
    });
  });

  it('discards other-day rounds when a new day flips (never bleeds yesterday in)', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    improveHole(0, 'forêt', 0); // solved a hole yesterday
    expect(activeRound()?.guessCount).toBe(1);

    // A new day flips -> a different key -> yesterday's round is pruned, today starts fresh.
    ensureRound('d:6:fr', freshHoles());
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('d:6:fr');
    expect(s.rounds['d:5:fr']).toBeUndefined(); // pruned
    expect(s.rounds['d:6:fr']).toEqual({ holes: freshHoles(), guessCount: 0, tried: [], progress: 0 });
  });

  it('switching LANGUAGE keeps both rounds; coming back restores the in-progress one', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    improveHole(0, 'forêt', 12);

    // Switch to the same day's other language: the FR round survives untouched.
    ensureRound('d:5:en', freshHoles());
    expect(activeRound()?.guessCount).toBe(0); // EN is fresh
    expect(useGameStore.getState().rounds['d:5:fr']).toBeDefined();

    // Come back to FR: its mid-game state is restored, not reset.
    ensureRound('d:5:fr', freshHoles());
    const fr = activeRound();
    expect(fr?.guessCount).toBe(1);
    expect(fr?.holes[0].rank).toBe(12);
    expect(fr?.tried).toEqual(['bois']);
  });

  it('the SAME key is a no-op -> mid-round progress rehydrates untouched', () => {
    const { ensureRound, recordGuess, improveHole, syncProgress } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    improveHole(0, 'forêt', 12);
    syncProgress(42);
    const mid = activeRound();

    // A reload calls ensureRound again with the SAME key + the same fresh holes.
    ensureRound('d:5:fr', freshHoles());
    const after = activeRound();
    expect(after).toEqual(mid); // NOT reset to freshHoles
    expect(after?.holes[0].rank).toBe(12);
    expect(after?.guessCount).toBe(1);
    expect(after?.tried).toEqual(['bois']);
    expect(after?.progress).toBe(42);
  });
});

describe('recordGuess — score = unique valid tries (on the active round)', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles()));

  it('counts each distinct guess once', () => {
    const { recordGuess } = useGameStore.getState();
    recordGuess('bois');
    recordGuess('vieux');
    expect(activeRound()?.guessCount).toBe(2);
    expect(activeRound()?.tried).toEqual(['bois', 'vieux']);
  });

  it('does not re-count a repeated (already folded) guess', () => {
    const { recordGuess } = useGameStore.getState();
    recordGuess('bois');
    recordGuess('bois');
    expect(activeRound()?.guessCount).toBe(1);
    expect(activeRound()?.tried).toEqual(['bois']);
  });
});

describe('improveHole — closer word + lower rank, others untouched', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles()));

  it('swaps in the improved hole only', () => {
    useGameStore.getState().improveHole(1, 'antique', 3);
    const holes = activeRound()!.holes;
    expect(holes[1]).toEqual({ pos: 2, secret: 'ancienne', word: 'antique', rank: 3, startRank: 40 });
    expect(holes[0]).toEqual(freshHoles()[0]); // untouched
  });

  it('rank 0 marks a hole solved (locked)', () => {
    useGameStore.getState().improveHole(0, 'forêt', 0);
    expect(activeRound()!.holes[0].rank).toBe(0);
  });
});

describe('syncProgress — cached per round for the selector badge', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles()));

  it('stores the value on the active round', () => {
    useGameStore.getState().syncProgress(63);
    expect(activeRound()?.progress).toBe(63);
  });

  it('is a no-op when unchanged (same object reference kept)', () => {
    const { syncProgress } = useGameStore.getState();
    syncProgress(50);
    const before = useGameStore.getState().rounds;
    syncProgress(50);
    expect(useGameStore.getState().rounds).toBe(before); // no churn
  });
});

describe('setLastLang — remembers the last valid language', () => {
  it('records a supported language and ignores anything else', () => {
    const { setLastLang } = useGameStore.getState();
    setLastLang('fr');
    expect(useGameStore.getState().lastLang).toBe('fr');
    setLastLang('de'); // not a supported language -> ignored
    expect(useGameStore.getState().lastLang).toBe('fr');
  });
});

// Restore the module's initial state so a later import sees a clean store.
useGameStore.setState(initial, false);
