// CONTRACT: the day-keyed round store (packages/web/src/state/gameStore.ts),
// asserted against issue #7's acceptance criteria + the AGENTS.md invariants it
// touches:
//   - progress is keyed on (dayNumber, language) via `roundKey`; a NEW key discards
//     the stale round (a new day never bleeds yesterday's state in), the SAME key
//     rehydrates the stored progress untouched (mid-round reload);
//   - score = number of UNIQUE valid tries, deduped by folded slug;
//   - an improved hole swaps in the closer word + lower rank; solved holes stay locked.

import { describe, it, expect, beforeEach } from 'vitest';
import { useGameStore } from './gameStore';
import type { RuntimeHole } from '@whippin/shared';

const initial = useGameStore.getState();

// Two holes at their start ranks — the fresh state a round begins from.
function freshHoles(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'foret', word: 'bois', rank: 87, startRank: 87 },
    { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
  ];
}

beforeEach(() => {
  // Reset to a pristine store between tests (replace, keeping the actions).
  useGameStore.setState(
    { roundKey: null, holes: [], guessCount: 0, tried: [], lang: null },
    false,
  );
});

describe('ensureRound — day/language keying', () => {
  it('initializes a fresh round for a brand-new key', () => {
    useGameStore.getState().ensureRound('d:5:fr', freshHoles());
    const s = useGameStore.getState();
    expect(s.roundKey).toBe('d:5:fr');
    expect(s.holes).toEqual(freshHoles());
    expect(s.guessCount).toBe(0);
    expect(s.tried).toEqual([]);
  });

  it('discards stale-day progress when the key changes (new day starts fresh)', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    improveHole(0, 'forêt', 0); // solved a hole yesterday
    expect(useGameStore.getState().guessCount).toBe(1);

    // A new day flips -> a different key -> everything resets.
    ensureRound('d:6:fr', freshHoles());
    const s = useGameStore.getState();
    expect(s.roundKey).toBe('d:6:fr');
    expect(s.holes).toEqual(freshHoles());
    expect(s.guessCount).toBe(0);
    expect(s.tried).toEqual([]);
  });

  it('switching language is also a new key -> fresh round', () => {
    const { ensureRound, recordGuess } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    ensureRound('d:5:en', freshHoles());
    expect(useGameStore.getState().guessCount).toBe(0);
  });

  it('the SAME key is a no-op -> mid-round progress rehydrates untouched', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    improveHole(0, 'forêt', 12);
    const mid = useGameStore.getState();

    // A reload calls ensureRound again with the SAME key + the same fresh holes.
    ensureRound('d:5:fr', freshHoles());
    const after = useGameStore.getState();
    expect(after.holes).toEqual(mid.holes); // NOT reset to freshHoles
    expect(after.holes[0].rank).toBe(12);
    expect(after.guessCount).toBe(1);
    expect(after.tried).toEqual(['bois']);
  });
});

describe('recordGuess — score = unique valid tries', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles()));

  it('counts each distinct guess once', () => {
    const { recordGuess } = useGameStore.getState();
    recordGuess('bois');
    recordGuess('vieux');
    expect(useGameStore.getState().guessCount).toBe(2);
    expect(useGameStore.getState().tried).toEqual(['bois', 'vieux']);
  });

  it('does not re-count a repeated (already folded) guess', () => {
    const { recordGuess } = useGameStore.getState();
    recordGuess('bois');
    recordGuess('bois');
    expect(useGameStore.getState().guessCount).toBe(1);
    expect(useGameStore.getState().tried).toEqual(['bois']);
  });
});

describe('improveHole — closer word + lower rank, others untouched', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles()));

  it('swaps in the improved hole only', () => {
    useGameStore.getState().improveHole(1, 'antique', 3);
    const holes = useGameStore.getState().holes;
    expect(holes[1]).toEqual({ pos: 2, secret: 'ancienne', word: 'antique', rank: 3, startRank: 40 });
    expect(holes[0]).toEqual(freshHoles()[0]); // untouched
  });

  it('rank 0 marks a hole solved (locked)', () => {
    useGameStore.getState().improveHole(0, 'forêt', 0);
    expect(useGameStore.getState().holes[0].rank).toBe(0);
  });
});

// Restore the module's initial state so a later import sees a clean store.
useGameStore.setState(initial, false);
