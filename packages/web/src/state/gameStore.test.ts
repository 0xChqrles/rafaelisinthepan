// CONTRACT: the day-keyed round store (packages/web/src/state/gameStore.ts). Rounds are
// held in a MAP keyed by roundKey = (dayNumber, language), so:
//   - day rounds are KEPT across days so the archive can rehydrate a past day's progress
//     (#54); any legacy non-day round is dropped, and the map is bounded by the
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
import { useGameStore, roundKeyForDay, migratePersisted, holesMatchPuzzle } from './gameStore';
import type { RuntimeHole } from '@whippin/shared';

const initial = useGameStore.getState();

// Two holes at their start ranks — the fresh state a round begins from.
function freshHoles(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'foret', word: 'bois', rank: 87, startRank: 87 },
    { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
  ];
}

function repeatedSecretHoles(): RuntimeHole[] {
  return [
    { pos: 1, secret: 'chat', word: 'animal', rank: 60, startRank: 60 },
    { pos: 3, secret: 'chat', word: 'bête', rank: 60, startRank: 60 },
    { pos: 5, secret: 'jardin', word: 'parc', rank: 40, startRank: 40 },
  ];
}

// The active round (rounds[activeKey]) — what the game screen reads.
function activeRound() {
  const s = useGameStore.getState();
  return s.activeKey ? s.rounds[s.activeKey] : undefined;
}

beforeEach(() => {
  // Reset to a pristine store between tests (merge, keeping the actions).
  useGameStore.setState(
    {
      rounds: {},
      wordRounds: {},
      lastLang: null,
      lastMode: null,
      onboarded: false,
      solvedDays: {},
      activeKey: null,
      activeWordKey: null,
    },
    false,
  );
});

describe('roundKeyForDay', () => {
  it('is (day, lang) and matches the documented format', () => {
    expect(roundKeyForDay(5, 'fr')).toBe('d:5:fr');
    expect(roundKeyForDay(6, 'en')).toBe('d:6:en');
  });
  it('carries the MODE (#156) — the two dailies can never share a key', () => {
    expect(roundKeyForDay(5, 'fr', 'word')).toBe('w:5:fr');
    expect(roundKeyForDay(5, 'fr', 'sentence')).toBe('d:5:fr');
    expect(roundKeyForDay(5, 'fr', 'word')).not.toBe(roundKeyForDay(5, 'fr'));
  });
});

describe('word rounds (#156) — ensureWordRound / recordWordGuess', () => {
  // A replay that ignores the log and reports a fixed outcome — for the tests that are
  // about the LOG, not about what it means. `countLog` below is the opposite.
  const outcome = (claimed: number, ended: boolean) => () => ({ claimed, ended });

  it('initializes a fresh word round and makes it active, separate from sentence rounds', () => {
    const { ensureRound, ensureWordRound } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles());
    ensureWordRound('w:5:fr', 'phare');
    const s = useGameStore.getState();
    expect(s.activeWordKey).toBe('w:5:fr');
    expect(s.wordRounds['w:5:fr']).toEqual({ word: 'phare', tried: [], claimed: 0, ended: false });
    // The sentence round is untouched — the two dailies' progress never collide.
    expect(s.rounds['d:5:fr']).toBeDefined();
    expect(s.activeKey).toBe('d:5:fr');
  });

  it('rehydrates the SAME key playing the same word; a republished different word resets', () => {
    const { ensureWordRound, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    recordWordGuess('mer', outcome(1, false));
    ensureWordRound('w:5:fr', 'phare');
    expect(useGameStore.getState().wordRounds['w:5:fr'].tried).toEqual(['mer']);
    ensureWordRound('w:5:fr', 'ocean'); // republished word
    expect(useGameStore.getState().wordRounds['w:5:fr']).toEqual({
      word: 'ocean',
      tried: [],
      claimed: 0,
      ended: false,
    });
  });

  it('recordWordGuess appends counted guesses, caches claimed/ended, refuses after the end', () => {
    const { ensureWordRound, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    recordWordGuess('mer', outcome(1, false));
    recordWordGuess('loin', outcome(1, true)); // the ending strike
    let round = useGameStore.getState().wordRounds['w:5:fr'];
    expect(round).toEqual({ word: 'phare', tried: ['mer', 'loin'], claimed: 1, ended: true });
    recordWordGuess('tard', outcome(2, true)); // past the end — must not enter the log
    round = useGameStore.getState().wordRounds['w:5:fr'];
    expect(round.tried).toEqual(['mer', 'loin']);
  });

  // The cache describes the log it is stored beside, never the caller's snapshot of it:
  // `recordWordGuess` replays what it just appended to. Two submissions batched into one
  // tick both close over the same pre-render `tried`, so a caller computing the numbers
  // itself would have the second overwrite the first's count with a replay blind to it.
  it('recomputes claimed/ended from the STORE\'s log, not the caller\'s snapshot', () => {
    const { ensureWordRound, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    const countLog = (log: string[]) => ({ claimed: log.length, ended: false });
    recordWordGuess('mer', countLog);
    recordWordGuess('sel', countLog); // same tick — the caller never re-rendered
    expect(useGameStore.getState().wordRounds['w:5:fr']).toEqual({
      word: 'phare',
      tried: ['mer', 'sel'],
      claimed: 2, // both, not the 1 a stale snapshot would have cached
      ended: false,
    });
  });

  it('keeps past days\' word rounds when a new day flips (archive history)', () => {
    const { ensureWordRound, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    recordWordGuess('mer', outcome(1, false));
    ensureWordRound('w:6:fr', 'foret');
    const s = useGameStore.getState();
    expect(s.wordRounds['w:5:fr']?.tried).toEqual(['mer']);
    expect(s.wordRounds['w:6:fr']).toEqual({ word: 'foret', tried: [], claimed: 0, ended: false });
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

  it('drops a legacy non-day round from storage while keeping the day rounds', () => {
    const { ensureRound, recordGuess } = useGameStore.getState();
    // Simulate an older persisted blob that still carries a retired ?puzzle= override
    // round ("o:<nonce>:<lang>") alongside a real day round.
    ensureRound('d:5:fr', freshHoles());
    recordGuess('bois');
    useGameStore.setState((s) => ({
      rounds: { ...s.rounds, 'o:legacy:fr': { holes: freshHoles(), guessCount: 3, tried: ['x', 'y', 'z'], progress: 10 } },
    }));

    // The next reconcile to any day key purges the legacy round and preserves day history.
    ensureRound('d:6:en', freshHoles());
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('d:6:en');
    expect(s.rounds['o:legacy:fr']).toBeUndefined(); // legacy round dropped
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

  it('matches duplicate secret slugs by position without collapsing hole instances', () => {
    const repeated = repeatedSecretHoles();
    expect(holesMatchPuzzle(repeated, repeated.map((hole) => ({ ...hole })))).toBe(true);
    expect(
      holesMatchPuzzle(repeated, [
        repeated[0],
        { ...repeated[1], pos: 4 },
        repeated[2],
      ]),
    ).toBe(false);

    useGameStore.getState().ensureRound('d:5:fr', repeated);
    useGameStore.getState().improveHole(0, 'chat', 0);
    useGameStore.getState().ensureRound('d:5:fr', repeated);

    expect(activeRound()?.holes).toHaveLength(3);
    expect(activeRound()?.holes.map((hole) => hole.pos)).toEqual([1, 3, 5]);
    expect(activeRound()?.holes.map((hole) => hole.rank)).toEqual([0, 60, 40]);
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

  it('dedupes by the caller-supplied canonical identity: an inflection of an already-tried word never counts (#104)', () => {
    const { recordGuess } = useGameStore.getState();
    // The Game passes guessKey over the puzzle ranks; the store only sees the mapping.
    const keyOf = (t: string) => (t === 'privee' || t === 'prive' ? 'a:2' : t);

    recordGuess('prive', keyOf);
    recordGuess('privee', keyOf); // same word, different inflection -> ONE try
    recordGuess('bois', keyOf);

    expect(activeRound()?.guessCount).toBe(2);
    // The uncounted variant does not enter the recall history either.
    expect(activeRound()?.tried).toEqual(['prive', 'bois']);
  });

  it('counts one shared-secret solve once even when it resolves repeated holes', () => {
    useGameStore.getState().ensureRound('d:5:fr', repeatedSecretHoles());
    const { recordGuess, improveHole } = useGameStore.getState();

    recordGuess('chat');
    recordGuess('chat');
    improveHole(0, 'chat', 0);
    improveHole(1, 'chat', 0);

    expect(activeRound()?.guessCount).toBe(1);
    expect(activeRound()?.tried).toEqual(['chat']);
    expect(activeRound()?.holes.slice(0, 2).map((hole) => hole.rank)).toEqual([0, 0]);
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

describe('recordSolve — per-language solved-day set (#56)', () => {
  const solved = (lang: string) => useGameStore.getState().solvedDays[lang];

  it('inserts a solved day and keeps the array sorted + deduped', () => {
    const { recordSolve } = useGameStore.getState();
    expect(recordSolve('fr', 12, 12)).toBe(true); // solved today -> [12]
    expect(recordSolve('fr', 11, 12)).toBe(true); // flip-edge -> sorted back to [11, 12]
    expect(solved('fr')).toEqual([11, 12]);
  });

  it('same-day double call is a no-op (re-solves / rehydration never double-count)', () => {
    const { recordSolve } = useGameStore.getState();
    expect(recordSolve('fr', 12, 12)).toBe(true);
    expect(recordSolve('fr', 12, 12)).toBe(false);
    expect(solved('fr')).toEqual([12]);
  });

  it('an older solvedDay (archive replay) is a no-op — never touches the streak', () => {
    const { recordSolve } = useGameStore.getState();
    recordSolve('fr', 12, 12);
    expect(recordSolve('fr', 5, 12)).toBe(false); // archive day (< activeDay - 1)
    expect(solved('fr')).toEqual([12]);
  });

  it('the activeDay - 1 flip-edge case inserts (in-flight round finished just past 22:00)', () => {
    const { recordSolve } = useGameStore.getState();
    // The round is yesterday's (dayNumber 11) but the active day already flipped to 12.
    expect(recordSolve('fr', 11, 12)).toBe(true);
    expect(solved('fr')).toEqual([11]);
  });

  it('caps each language to MAX_SOLVED_DAYS, dropping the oldest', () => {
    const CAP = 800;
    // Seed CAP consecutive solved days directly, then solve one more past the active day.
    const seeded = Array.from({ length: CAP }, (_, i) => i + 1); // 1..CAP
    useGameStore.setState({ solvedDays: { fr: seeded } }, false);
    useGameStore.getState().recordSolve('fr', CAP + 1, CAP + 1);
    const days = solved('fr');
    expect(days.length).toBe(CAP); // still capped
    expect(days[0]).toBe(2); // oldest (day 1) evicted
    expect(days[days.length - 1]).toBe(CAP + 1); // newest kept
  });

  it('is per-language — an fr solve does not touch en', () => {
    const { recordSolve } = useGameStore.getState();
    recordSolve('fr', 12, 12);
    expect(solved('fr')).toEqual([12]);
    expect(solved('en')).toBeUndefined();
  });
});

describe('migratePersisted — persisted-blob upgrades', () => {
  it('discards a v0 blob entirely (one-time reset)', () => {
    expect(migratePersisted({ roundKey: 'x', holes: [] }, 0)).toEqual({
      rounds: {},
      wordRounds: {},
      lastLang: null,
      lastMode: null,
      onboarded: false,
      solvedDays: {},
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

  it('drops retired fields (v1 keyboard layout, v4 routeSeen) while keeping the current ones', () => {
    const out = migratePersisted(
      { rounds: {}, lastLang: 'en', layout: 'azerty', routeSeen: true },
      1,
    );
    expect(out).toEqual({
      rounds: {},
      wordRounds: {},
      lastLang: 'en',
      lastMode: null,
      onboarded: true,
      solvedDays: {},
    });
    expect('layout' in out).toBe(false);
    expect('routeSeen' in out).toBe(false);
  });

  it('v2 -> v3 adds an empty solvedDays and preserves rounds/lastLang/onboarded', () => {
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a', 'b'], progress: 10 } };
    const out = migratePersisted({ rounds, lastLang: 'fr', onboarded: true }, 2);
    expect(out).toEqual({
      rounds,
      wordRounds: {},
      lastLang: 'fr',
      lastMode: null,
      onboarded: true,
      solvedDays: {},
    });
  });

  // v4 -> v5 (#155): `routeSeen` armed the one-time first-solve auto-open, which went away
  // with the onboarding rework — the tutorial now ends by tapping a word, so the map has
  // nothing left to introduce mid-round. A v4 blob carrying the flag upgrades cleanly and
  // loses nothing else.
  it('v4 -> v5 drops routeSeen and preserves every other field', () => {
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a', 'b'], progress: 10 } };
    const solvedDays = { fr: [10, 11], en: [10] };
    const out = migratePersisted(
      { rounds, lastLang: 'fr', onboarded: true, solvedDays, routeSeen: true },
      4,
    );
    expect(out).toEqual({
      rounds,
      wordRounds: {},
      lastLang: 'fr',
      lastMode: null,
      onboarded: true,
      solvedDays,
    });
  });

  // v5 -> v6 (#156): Word mode adds its own rounds map and the last-played mode. An
  // older blob gets an empty map + no preference; a v6 blob keeps both.
  it('v5 -> v6 adds empty wordRounds + null lastMode; a v6 blob keeps both', () => {
    const out = migratePersisted({ rounds: {}, lastLang: 'fr', onboarded: true, solvedDays: {} }, 5);
    expect(out.wordRounds).toEqual({});
    expect(out.lastMode).toBeNull();
    const wordRounds = { 'w:5:fr': { word: 'phare', tried: ['mer'], claimed: 1, ended: false } };
    const kept = migratePersisted(
      { rounds: {}, wordRounds, lastLang: 'fr', lastMode: 'word', onboarded: true, solvedDays: {} },
      6,
    );
    expect(kept.wordRounds).toEqual(wordRounds);
    expect(kept.lastMode).toBe('word');
  });

  it('keeps an existing solvedDays across the upgrade (no backfill, but no data loss)', () => {
    const solvedDays = { fr: [10, 11], en: [10] };
    expect(migratePersisted({ rounds: {}, lastLang: 'fr', onboarded: true, solvedDays }, 2).solvedDays).toEqual(
      solvedDays,
    );
  });
});

// Restore the module's initial state so a later import sees a clean store.
useGameStore.setState(initial, false);
