// CONTRACT: the day-keyed round store (packages/web/src/state/gameStore.ts). Rounds are
// held in a MAP keyed by roundKey = (dayNumber, language), so:
//   - day rounds are KEPT across days so the archive can rehydrate a past day's progress
//     (#54); only ?puzzle= override rounds are pruned, and the map is bounded by the
//     MAX_DAY_ROUNDS most-recent cap (oldest day rounds evicted beyond it);
//   - switching LANGUAGE keeps BOTH rounds — coming back restores the in-progress one
//     (drives the language selector's per-language status + no-confirmation switching);
//   - the SAME key rehydrates the stored progress untouched (mid-round reload) — UNLESS
//     the puzzle was re-published with a different sentence (holes no longer match), in
//     which case the round resets so stale holes never reach scoring;
//   - score = number of UNIQUE valid tries, deduped by folded slug;
//   - an improved hole swaps in the closer word + lower rank; solved holes stay locked;
//   - progress is cached per round for the selector badge;
//   - lastLang remembers the last valid language (seeds the `/` redirect).

import { describe, it, expect, beforeEach } from 'vitest';
import { useGameStore, roundKeyForDay, migratePersisted } from './gameStore';
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
  useGameStore.setState({ rounds: {}, lastLang: null, onboarded: false, activeKey: null }, false);
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

  it('KEEPS yesterday\'s day round when a new day flips (archive history, #54)', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    improveHole(0, 'forêt', 0); // solved a hole yesterday
    expect(activeRound()?.guessCount).toBe(1);

    // A new day flips -> a different key -> today starts fresh, but yesterday's round
    // survives so the archive can rehydrate its progress.
    ensureRound('d:6:fr', freshHoles());
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('d:6:fr');
    expect(s.rounds['d:5:fr']?.guessCount).toBe(1); // preserved
    expect(s.rounds['d:5:fr']?.holes[0].rank).toBe(0);
    expect(s.rounds['d:6:fr']).toEqual({ holes: freshHoles(), guessCount: 0, tried: [], progress: 0 });
  });

  it('caps the map: with > MAX_DAY_ROUNDS day rounds the oldest are evicted, the newest kept', () => {
    const CAP = 800;
    // Seed CAP day rounds (days 1..CAP), each with a distinguishing guessCount, directly
    // in the store (bypassing ensureRound so the seeding itself never caps).
    const seeded: Record<string, typeof initial.rounds[string]> = {};
    for (let day = 1; day <= CAP; day++) {
      seeded[`d:${day}:fr`] = { holes: freshHoles(), guessCount: day, tried: [], progress: 0 };
    }
    useGameStore.setState({ rounds: seeded, activeKey: null }, false);

    // A brand-new newest day pushes the count over the cap -> the single oldest (day 1) is
    // evicted; everything newer, including the new active round, is kept.
    useGameStore.getState().ensureRound(`d:${CAP + 1}:fr`, freshHoles());
    const s = useGameStore.getState();
    expect(Object.keys(s.rounds).length).toBe(CAP); // still capped
    expect(s.rounds['d:1:fr']).toBeUndefined(); // oldest evicted
    expect(s.rounds['d:2:fr']?.guessCount).toBe(2); // next-oldest survives
    expect(s.rounds[`d:${CAP + 1}:fr`]).toBeDefined(); // newest kept
    expect(s.rounds[`d:${CAP}:fr`]?.guessCount).toBe(CAP); // prior newest kept
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

  it('an override (non-day) round never wipes the day rounds', () => {
    const { ensureRound, recordGuess } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');

    // Loading a ?puzzle= test file must not destroy the real day's progress.
    ensureRound('o:nonce:fr', freshHoles());
    let s = useGameStore.getState();
    expect(s.activeKey).toBe('o:nonce:fr');
    expect(s.rounds['d:5:fr']?.guessCount).toBe(1); // day progress intact

    // Coming back to a day key prunes the stale override round, keeps the day's.
    ensureRound('d:5:en', freshHoles());
    s = useGameStore.getState();
    expect(s.rounds['o:nonce:fr']).toBeUndefined();
    expect(s.rounds['d:5:fr']?.guessCount).toBe(1);
  });

  it('a new override key prunes the previous override but keeps the day rounds', () => {
    const { ensureRound, recordGuess } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    ensureRound('o:one:fr', freshHoles()); // first ?puzzle= load

    // A second override load replaces the first among override rounds, but the real day
    // round stays untouched.
    ensureRound('o:two:fr', freshHoles());
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('o:two:fr');
    expect(s.rounds['o:one:fr']).toBeUndefined(); // previous override pruned
    expect(s.rounds['o:two:fr']).toBeDefined();
    expect(s.rounds['d:5:fr']?.guessCount).toBe(1); // day round intact
  });

  it('resets when the same (day, lang) key is re-published with a DIFFERENT sentence', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    improveHole(0, 'forêt', 12);

    // Same key, but the day's puzzle changed: new holes carry secrets absent from the
    // old round. Rehydrating them would crash scoring, so the round must reset instead.
    const newHoles: RuntimeHole[] = [
      { pos: 2, secret: 'chat', word: 'animal', rank: 60, startRank: 60 },
      { pos: 4, secret: 'noir', word: 'sombre', rank: 30, startRank: 30 },
    ];
    ensureRound('d:5:fr', newHoles);
    expect(activeRound()).toEqual({ holes: newHoles, guessCount: 0, tried: [], progress: 0 });
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

  it('is monotonic — a worse or equal rank is ignored (a stale deferred swap never regresses a hole)', () => {
    const { improveHole } = useGameStore.getState();
    improveHole(1, 'antique', 3);
    // Game defers swaps to the hit fade-out: a guess submitted inside that window was
    // judged against the pre-swap rank, so its late timer must not undo the better one.
    improveHole(1, 'vieillotte', 10); // worse
    improveHole(1, 'antique', 3); // equal
    expect(activeRound()!.holes[1]).toMatchObject({ word: 'antique', rank: 3 });
  });

  it('never un-solves a solved hole', () => {
    const { improveHole } = useGameStore.getState();
    improveHole(0, 'forêt', 0); // solved
    improveHole(0, 'bosquet', 20); // stale timer firing after the solve
    expect(activeRound()!.holes[0]).toMatchObject({ word: 'forêt', rank: 0 });
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

describe('onboarded — the tutorial flag (#51)', () => {
  it('setOnboarded marks the tutorial seen (finish AND skip both call it)', () => {
    expect(useGameStore.getState().onboarded).toBe(false);
    useGameStore.getState().setOnboarded();
    expect(useGameStore.getState().onboarded).toBe(true);
  });
});

describe('migratePersisted — persisted-blob upgrades', () => {
  it('discards a v0 blob entirely (one-time reset)', () => {
    expect(migratePersisted({ roundKey: 'x', holes: [] }, 0)).toEqual({
      rounds: {},
      lastLang: null,
      onboarded: false,
    });
  });

  it('grandfathers a v1 blob with prior play state — a veteran never sees the tutorial', () => {
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a', 'b'], progress: 10 } };
    expect(migratePersisted({ rounds, lastLang: 'fr' }, 1).onboarded).toBe(true);
    // Either signal alone is enough: rounds without lastLang, or lastLang without rounds.
    expect(migratePersisted({ rounds, lastLang: null }, 1).onboarded).toBe(true);
    expect(migratePersisted({ rounds: {}, lastLang: 'en' }, 1).onboarded).toBe(true);
  });

  it('a v1 blob with NO play state gets the tutorial (onboarded stays false)', () => {
    expect(migratePersisted({ rounds: {}, lastLang: null }, 1).onboarded).toBe(false);
  });

  it('keeps an explicit onboarded value over the grandfathering inference', () => {
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a'], progress: 0 } };
    expect(migratePersisted({ rounds, lastLang: 'fr', onboarded: false }, 2).onboarded).toBe(false);
  });

  it('drops retired fields (v1 keyboard layout) while keeping the current ones', () => {
    const out = migratePersisted({ rounds: {}, lastLang: 'en', layout: 'azerty' }, 1);
    expect(out).toEqual({ rounds: {}, lastLang: 'en', onboarded: true });
    expect('layout' in out).toBe(false);
  });
});

// Restore the module's initial state so a later import sees a clean store.
useGameStore.setState(initial, false);
