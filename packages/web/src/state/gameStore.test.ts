// CONTRACT: the day-keyed round store (packages/web/src/state/gameStore.ts). Rounds are
// held in a MAP keyed by roundKey = (dayNumber, language), so:
//   - day rounds are KEPT across days so the archive can rehydrate a past day's progress
//     (#54); any legacy non-day round is dropped, and the map is bounded by the
//     MAX_DAY_ROUNDS most-recent cap (oldest day rounds evicted beyond it);
//   - switching LANGUAGE keeps BOTH rounds — coming back restores the in-progress one
//     (drives the language selector's per-language status + no-confirmation switching);
//   - the SAME key + published revision rehydrates stored progress untouched (mid-round
//     reload); a new revision resets even when only the rank maps changed, while the hole
//     check remains a structural safety floor;
//   - score = number of UNIQUE valid tries, deduped by folded slug;
//   - an improved hole swaps in the closer word + lower rank; solved holes stay locked;
//   - progress is cached per round for the selector badge;
//   - lastLang remembers the last valid language (seeds the `/` redirect).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGameStore, roundKeyForDay, migratePersisted, holesMatchPuzzle } from './gameStore';

// The published VERSION a round is played on (#203). Every call here plays ONE version;
// what a REPUBLISH does has its own suite below.
const REV = 'a1b2c3d4e5f60718';
import { runMs } from '../game/wordGame';
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
      boardTab: 'friends',
      sentenceRulesSeen: false,
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

// CONTRACT (#156 word rounds, retimed by #163): a word round is its LOG plus the wall
// clock it is being played against. `startedAt` is stamped once by START and never again
// (the daily is one-shot); `deadline` is DERIVED — startedAt + runMs of what the whole
// log's claims bought — and re-derived on every write, so the clock always describes the
// guesses that paid for it. Nothing stores "ended": that is `now > deadline`, asked
// fresh, which is exactly what makes the no-pause rule enforceable (there is no remaining
// value to freeze by closing the tab).
describe('word rounds (#163) — ensureWordRound / anchorWordRun / recordWordGuess', () => {
  // A replay stub: `n` claims worth `bonus` seconds each. The store must never look
  // inside it — it is the pure model closed over a rank map the store cannot see.
  const priced = (bonusEach: number) => (log: string[]) => ({
    claimed: log.length,
    bonus: log.length * bonusEach,
  });
  const openRun = priced(0);
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const wordRound = () => useGameStore.getState().wordRounds['w:5:fr'];

  it('initializes a fresh word round AT THE GATE, separate from sentence rounds', () => {
    const { ensureRound, ensureWordRound } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    ensureWordRound('w:5:fr', 'phare');
    const s = useGameStore.getState();
    expect(s.activeWordKey).toBe('w:5:fr');
    // No clock until START is tapped: the day is fetched, not yet begun.
    expect(s.wordRounds['w:5:fr']).toEqual({
      word: 'phare',
      startedAt: null,
      deadline: null,
      tried: [],
      claimed: 0,
    });
    // The sentence round is untouched — the two dailies' progress never collide.
    expect(s.rounds['d:5:fr']).toBeDefined();
    expect(s.activeKey).toBe('d:5:fr');
  });

  it('anchorWordRun opens the clock at the full run length, and only ONCE', () => {
    const { ensureWordRound, anchorWordRun } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    expect(wordRound()).toMatchObject({ startedAt: T0, deadline: T0 + runMs(0) });

    // A re-render, a double tap, a re-read or a rehydration must never restart a run:
    // there is no retry, and re-stamping would hand back a fresh minute mid-game.
    vi.setSystemTime(T0 + 5_000);
    anchorWordRun('w:5:fr', Date.now());
    expect(wordRound()).toMatchObject({ startedAt: T0, deadline: T0 + runMs(0) });
  });

  // #202: the anchor is a translated SERVER instant, so a device joining a run already in
  // progress lands its anchor that far in the PAST and its countdown resumes with the real
  // time left — the daily stays one-shot across devices.
  it('anchors a run already in progress to the elapsed time, not to now', () => {
    const { ensureWordRound, anchorWordRun } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', T0 - 20_000);
    expect(wordRound()).toMatchObject({ startedAt: T0 - 20_000, deadline: T0 - 20_000 + runMs(0) });
  });

  it('anchors nothing for a round that is not there (an answer landing after eviction)', () => {
    useGameStore.getState().anchorWordRun('w:99:fr', T0);
    expect(useGameStore.getState().wordRounds['w:99:fr']).toBeUndefined();
  });

  // #202: the server's RECORDED run, adopted by a device that never played the day — a
  // finished day's history following the player. Its deadline is re-priced off the adopted
  // log, so the post-mortem draws a run that really is over.
  it('adoptWordRun takes the recorded run and re-prices the clock from it', () => {
    const { ensureWordRound, anchorWordRun, adoptWordRun } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', T0 - 200_000);
    adoptWordRun('w:5:fr', { tried: ['mer', 'sel'], claimed: 2, bonus: 8 });
    expect(wordRound()).toMatchObject({
      tried: ['mer', 'sel'],
      claimed: 2,
      deadline: T0 - 200_000 + runMs(8),
    });
  });

  it('never adopts OVER a log this device played, and never before the clock exists', () => {
    const { ensureWordRound, anchorWordRun, adoptWordRun, recordWordGuess } =
      useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    // No clock yet: there is nothing to price a log against.
    adoptWordRun('w:5:fr', { tried: ['mer'], claimed: 1, bonus: 4 });
    expect(wordRound()).toMatchObject({ tried: [], startedAt: null });

    anchorWordRun('w:5:fr', Date.now());
    recordWordGuess('sel', priced(3));
    adoptWordRun('w:5:fr', { tried: ['mer', 'autre'], claimed: 2, bonus: 40 });
    // A word round's deadline is DERIVED from its log, so adopting a longer one over a run
    // this device actually played could move the clock and re-open a finished run.
    expect(wordRound()).toMatchObject({ tried: ['sel'], claimed: 1, deadline: T0 + runMs(3) });
  });

  it('markWordSubmitted records the server’s acknowledgement, idempotently', () => {
    const { ensureWordRound, markWordSubmitted } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    expect(wordRound().submitted).toBeUndefined();
    markWordSubmitted('w:5:fr');
    const after = wordRound();
    expect(after.submitted).toBe(true);
    markWordSubmitted('w:5:fr');
    expect(wordRound()).toBe(after); // no second write, so nothing re-serializes
  });

  it('a guess before START never lands — there is no clock to play against', () => {
    const { ensureWordRound, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    recordWordGuess('mer', openRun);
    expect(wordRound()).toMatchObject({ tried: [], startedAt: null, deadline: null });
  });

  it('a claim EXTENDS the deadline by what the whole log is worth', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    const pays3 = priced(3);
    recordWordGuess('mer', pays3);
    expect(wordRound()).toEqual({
      word: 'phare',
      startedAt: T0,
      deadline: T0 + runMs(3),
      tried: ['mer'],
      claimed: 1,
    });
    recordWordGuess('sel', pays3);
    // The deadline is startedAt + the run's whole length, never "the old deadline plus a
    // bonus" — which is the same number here and stays right when a republish reprices.
    expect(wordRound()).toMatchObject({ deadline: T0 + runMs(6), claimed: 2 });
  });

  it('anchors the deadline to startedAt, never to the moment the claim landed', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    // Mid-run — where a rolling-window regression (deadline = NOW + runMs) and the rule
    // (deadline = STARTEDAT + runMs) disagree. Every other landing-guess test claims with
    // the clock still at T0, where the two are the same number, so this is the one that
    // pins the anchor. Halfway through the OPENING clock, derived, so the guess is still
    // live whatever START_SECONDS is retuned to.
    vi.setSystemTime(T0 + runMs(0) / 2);
    expect(recordWordGuess('mer', priced(3))).toBe(true);
    expect(wordRound().deadline).toBe(T0 + runMs(3));
  });

  it('the deadline millisecond itself is still play — over means STRICTLY after', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    // Exactly AT the deadline: not over. One boundary, shared by this check,
    // `wordStatusOf` and `useDeadlinePassed`, so no surface can disagree about the
    // deadline's own millisecond.
    vi.setSystemTime(T0 + runMs(0));
    expect(recordWordGuess('juste', openRun)).toBe(true);
    expect(wordRound()).toMatchObject({ tried: ['juste'] });
  });

  it('a guess landing past the deadline is dead, however much time it would have bought', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    recordWordGuess('mer', openRun);
    vi.setSystemTime(T0 + runMs(0) + 1); // one millisecond past the end
    recordWordGuess('tard', priced(5));
    // Not appended — and the round is FROZEN, not merely closed to new guesses: a
    // re-price here could hand a finished run a later deadline and revive it.
    expect(wordRound()).toMatchObject({ tried: ['mer'], claimed: 1, deadline: T0 + runMs(0) });
    // The freeze covers the REPEAT/repair path too — the one write that could revive a
    // finished run without appending anything: a repeat priced richer by a republished
    // map must not move a spent deadline either.
    expect(recordWordGuess('mer', priced(30))).toBe(false);
    expect(wordRound()).toMatchObject({ claimed: 1, deadline: T0 + runMs(0) });
  });

  // The screen decides what FEEDBACK to show from a rendered value, which lags the wall
  // clock by up to a frame; the store decides what LANDS from `Date.now()` at the write.
  // The two can only be reconciled by the store telling the caller what it did — without
  // it, a guess entered in that window floats a rarity grade, pays a `+21s` clock gain and
  // announces a claim the run never took.
  it('REPORTS whether the guess landed, so the screen cannot celebrate a refused one', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    expect(recordWordGuess('mer', openRun), 'before START').toBe(false);
    anchorWordRun('w:5:fr', Date.now());
    expect(recordWordGuess('mer', openRun), 'a counted guess').toBe(true);
    expect(recordWordGuess('mer', openRun), 'a repeat appends nothing').toBe(false);
    vi.setSystemTime(T0 + runMs(0) + 1);
    expect(recordWordGuess('tard', priced(5)), 'past the deadline').toBe(false);
  });

  it('backgrounding the tab does not pause the clock — the deadline is wall-clock', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    // An hour away with the tab closed. Nothing ran, nothing ticked, and the run is over
    // all the same: an interrupted run is a ruined run, by decision.
    vi.setSystemTime(T0 + 3_600_000);
    recordWordGuess('mer', openRun);
    expect(wordRound()).toMatchObject({ tried: [] });
  });

  it('re-prices the log after a same-word republish instead of trusting the stored clock', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    recordWordGuess('mer', priced(3));
    expect(wordRound()).toMatchObject({ deadline: T0 + runMs(3) });

    // The word identity stayed the same, so ensureWordRound intentionally retained the
    // log — but the republished map ranks it differently, so what it BOUGHT changed.
    ensureWordRound('w:5:fr', 'phare');
    recordWordGuess('sel', priced(1));
    expect(wordRound()).toEqual({
      word: 'phare',
      startedAt: T0,
      deadline: T0 + runMs(2), // both guesses re-priced under the new map, not 3 + 1
      tried: ['mer', 'sel'],
      claimed: 2,
    });
  });

  it('rejects a guess when a same-word republish shrinks the live deadline into the past', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    recordWordGuess('mer', priced(30));
    expect(wordRound()).toMatchObject({ deadline: T0 + runMs(30), tried: ['mer'] });

    // The stored pre-publish clock still runs to `runMs(30)`. On the current map the
    // retained log buys no bonus, so its real deadline is `runMs(0)`: a guess landing
    // BETWEEN the two is already dead and cannot pay for the moment it arrived in.
    // The instant is the midpoint of that window, DERIVED from the knobs — a literal
    // wall-clock jump silently restates START_SECONDS and stops straddling the gap the
    // moment it is retuned (which is exactly what the 60 -> 120 change did to it).
    vi.setSystemTime(T0 + (runMs(0) + runMs(30)) / 2);
    ensureWordRound('w:5:fr', 'phare');
    expect(recordWordGuess('late', priced(0))).toBe(false);
    expect(wordRound()).toMatchObject({
      deadline: T0 + runMs(0),
      tried: ['mer'],
      claimed: 1,
    });
  });

  it('repairs the cached half even when the submission itself cannot land', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    recordWordGuess('mer', priced(3));
    // A REPEAT: nothing to append, but the republished map still says the stored log is
    // worth something else, and the status surfaces read that cache without a rank map.
    recordWordGuess('mer', priced(1));
    expect(wordRound()).toMatchObject({ tried: ['mer'], deadline: T0 + runMs(1) });
  });

  // The cache describes the log it is stored beside, never the caller's snapshot of it:
  // `recordWordGuess` replays what it just appended to. Two submissions batched into one
  // tick both close over the same pre-render `tried`, so a caller computing the numbers
  // itself would have the second overwrite the first's count with a replay blind to it.
  it('recomputes claimed/deadline from the STORE\'s log, not the caller\'s snapshot', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    const pays2 = priced(2);
    recordWordGuess('mer', pays2);
    recordWordGuess('sel', pays2); // same tick — the caller never re-rendered
    expect(wordRound()).toMatchObject({
      tried: ['mer', 'sel'],
      claimed: 2, // both, not the 1 a stale snapshot would have cached
      deadline: T0 + runMs(4),
    });
  });

  it('a republished DIFFERENT word resets the round back to its gate', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    recordWordGuess('mer', openRun);
    ensureWordRound('w:5:fr', 'ocean');
    expect(wordRound()).toEqual({
      word: 'ocean',
      startedAt: null,
      deadline: null,
      tried: [],
      claimed: 0,
    });
  });

  it('keeps past days\' word rounds when a new day flips (archive history)', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', Date.now());
    recordWordGuess('mer', openRun);
    ensureWordRound('w:6:fr', 'foret');
    const s = useGameStore.getState();
    expect(s.wordRounds['w:5:fr']?.tried).toEqual(['mer']);
    expect(s.wordRounds['w:6:fr']).toEqual({
      word: 'foret',
      startedAt: null,
      deadline: null,
      tried: [],
      claimed: 0,
    });
  });

  it('caps the word-round map like the sentence map: oldest evicted, newest kept', () => {
    const CAP = 800; // MAX_DAY_ROUNDS — one retention policy for both maps
    const seeded: Record<string, ReturnType<typeof wordRound> & object> = {};
    for (let day = 1; day <= CAP; day++) {
      seeded[`w:${day}:fr`] = { word: 'phare', startedAt: T0, deadline: T0, tried: [], claimed: day };
    }
    useGameStore.setState({ wordRounds: seeded, activeWordKey: null }, false);

    useGameStore.getState().ensureWordRound(`w:${CAP + 1}:fr`, 'foret');
    const s = useGameStore.getState();
    expect(Object.keys(s.wordRounds).length).toBe(CAP); // still capped
    expect(s.wordRounds['w:1:fr']).toBeUndefined(); // oldest evicted
    expect(s.wordRounds['w:2:fr']?.claimed).toBe(2); // next-oldest survives
    expect(s.wordRounds[`w:${CAP + 1}:fr`]).toBeDefined(); // newest kept
  });
});

describe('ensureRound — day/language keying', () => {
  it('initializes a fresh round for a brand-new key and makes it active', () => {
    useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV);
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('d:5:fr');
    expect(s.rounds['d:5:fr']).toEqual({
      holes: freshHoles(),
      guessCount: 0,
      tried: [],
      progress: 0,
      revision: REV,
    });
  });

  it('KEEPS yesterday\'s day round when a new day flips (archive history, #54)', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    recordGuess('bois');
    improveHole(0, 'forêt', 0); // solved a hole yesterday
    expect(activeRound()?.guessCount).toBe(1);

    // A new day flips -> a different key -> today starts fresh, but yesterday's round
    // survives so the archive can rehydrate its progress.
    ensureRound('d:6:fr', freshHoles(), REV);
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('d:6:fr');
    expect(s.rounds['d:5:fr']?.guessCount).toBe(1); // preserved
    expect(s.rounds['d:5:fr']?.holes[0].rank).toBe(0);
    expect(s.rounds['d:6:fr']).toEqual({
      holes: freshHoles(),
      guessCount: 0,
      tried: [],
      progress: 0,
      revision: REV,
    });
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
    useGameStore.getState().ensureRound(`d:${CAP + 1}:fr`, freshHoles(), REV);
    const s = useGameStore.getState();
    expect(Object.keys(s.rounds).length).toBe(CAP); // still capped
    expect(s.rounds['d:1:fr']).toBeUndefined(); // oldest evicted
    expect(s.rounds['d:2:fr']?.guessCount).toBe(2); // next-oldest survives
    expect(s.rounds[`d:${CAP + 1}:fr`]).toBeDefined(); // newest kept
    expect(s.rounds[`d:${CAP}:fr`]?.guessCount).toBe(CAP); // prior newest kept
  });

  it('switching LANGUAGE keeps both rounds; coming back restores the in-progress one', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    recordGuess('bois');
    improveHole(0, 'forêt', 12);

    // Switch to the same day's other language: the FR round survives untouched.
    ensureRound('d:5:en', freshHoles(), REV);
    expect(activeRound()?.guessCount).toBe(0); // EN is fresh
    expect(useGameStore.getState().rounds['d:5:fr']).toBeDefined();

    // Come back to FR: its mid-game state is restored, not reset.
    ensureRound('d:5:fr', freshHoles(), REV);
    const fr = activeRound();
    expect(fr?.guessCount).toBe(1);
    expect(fr?.holes[0].rank).toBe(12);
    expect(fr?.tried).toEqual(['bois']);
  });

  it('the SAME key is a no-op -> mid-round progress rehydrates untouched', () => {
    const { ensureRound, recordGuess, improveHole, syncProgress } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    recordGuess('bois');
    improveHole(0, 'forêt', 12);
    syncProgress(42);
    const mid = activeRound();

    // A reload calls ensureRound again with the SAME key + the same fresh holes.
    ensureRound('d:5:fr', freshHoles(), REV);
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
    ensureRound('d:5:fr', freshHoles(), REV);
    recordGuess('bois');
    useGameStore.setState((s) => ({
      rounds: { ...s.rounds, 'o:legacy:fr': { holes: freshHoles(), guessCount: 3, tried: ['x', 'y', 'z'], progress: 10 } },
    }));

    // The next reconcile to any day key purges the legacy round and preserves day history.
    ensureRound('d:6:en', freshHoles(), REV);
    const s = useGameStore.getState();
    expect(s.activeKey).toBe('d:6:en');
    expect(s.rounds['o:legacy:fr']).toBeUndefined(); // legacy round dropped
    expect(s.rounds['d:5:fr']?.guessCount).toBe(1); // day round intact
  });

  it('resets when the same (day, lang) key is re-published with a DIFFERENT sentence', () => {
    const { ensureRound, recordGuess, improveHole } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    recordGuess('bois');
    improveHole(0, 'forêt', 12);

    // Same key, but the day's puzzle changed: new holes carry secrets absent from the
    // old round. Rehydrating them would crash scoring, so the round must reset instead.
    const newHoles: RuntimeHole[] = [
      { pos: 2, secret: 'chat', word: 'animal', rank: 60, startRank: 60 },
      { pos: 4, secret: 'noir', word: 'sombre', rank: 30, startRank: 30 },
    ];
    ensureRound('d:5:fr', newHoles, REV);
    expect(activeRound()).toEqual({
      holes: newHoles,
      guessCount: 0,
      tried: [],
      progress: 0,
      revision: REV,
    });
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

    useGameStore.getState().ensureRound('d:5:fr', repeated, REV);
    useGameStore.getState().improveHole(0, 'chat', 0);
    useGameStore.getState().ensureRound('d:5:fr', repeated, REV);

    expect(activeRound()?.holes).toHaveLength(3);
    expect(activeRound()?.holes.map((hole) => hole.pos)).toEqual([1, 3, 5]);
    expect(activeRound()?.holes.map((hole) => hole.rank)).toEqual([0, 60, 40]);
  });
});

describe('recordGuess — score = unique valid tries (on the active round)', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV));

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
    useGameStore.getState().ensureRound('d:5:fr', repeatedSecretHoles(), REV);
    const { recordGuess, improveHole } = useGameStore.getState();

    recordGuess('chat');
    recordGuess('chat');
    improveHole(0, 'chat', 0);
    improveHole(1, 'chat', 0);

    expect(activeRound()?.guessCount).toBe(1);
    expect(activeRound()?.tried).toEqual(['chat']);
    expect(activeRound()?.holes.slice(0, 2).map((hole) => hole.rank)).toEqual([0, 0]);
  });

  it('reports whether the guess entered the log — the sync engine flushes only counted tries (#201)', () => {
    const { recordGuess } = useGameStore.getState();
    expect(recordGuess('bois')).toBe(true);
    expect(recordGuess('bois')).toBe(false);
    expect(activeRound()?.tried).toEqual(['bois']);
  });
});

describe('adoptRound — the server answer becomes the round truth (#201)', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV));

  it('replaces tried + holes and derives the count from the merged log', () => {
    const adopted: RuntimeHole[] = [
      { pos: 1, secret: 'foret', word: 'sous-bois', rank: 3, startRank: 87 },
      { pos: 2, secret: 'ancienne', word: 'vieille', rank: 40, startRank: 40 },
    ];
    useGameStore.getState().adoptRound('d:5:fr', ['bois', 'chemin'], adopted, 62);
    const round = activeRound()!;
    expect(round.tried).toEqual(['bois', 'chemin']);
    // The score IS the number of unique tries — derived, never a second stored answer.
    expect(round.guessCount).toBe(2);
    expect(round.holes).toEqual(adopted);
  });

  it('refreshes the cached progress with the board it describes', () => {
    // The archive cell and the language strip read this cached number verbatim, and
    // `syncProgress` can only ever repair the ACTIVE round — an adoption landing after
    // the player navigated away would otherwise leave that day painting a stale fill
    // until they reopened exactly that day.
    expect(activeRound()?.progress).toBe(0);
    useGameStore.getState().adoptRound('d:5:fr', ['bois'], freshHoles(), 41.5);
    expect(activeRound()?.progress).toBe(41.5);
  });

  it('leaves an unknown key ABSENT (the round was evicted or reset mid-flight)', () => {
    useGameStore.getState().adoptRound('d:9:en', ['x'], [], 10);
    // Materializing the round here would create one with no cached progress, which
    // `statusOf` renders as a NaN% archive cell. The key must simply stay gone.
    expect(useGameStore.getState().rounds['d:9:en']).toBeUndefined();
  });
});

describe('markRoundCapped — the cap stops the round counting (#201)', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV));

  it('marks the round capped', () => {
    useGameStore.getState().markRoundCapped('d:5:fr');
    expect(activeRound()?.capped).toBe(true);
  });

  it('is idempotent — a second call writes NOTHING', () => {
    const { markRoundCapped } = useGameStore.getState();
    markRoundCapped('d:5:fr');
    const capped = activeRound();
    markRoundCapped('d:5:fr');
    // Same object, not merely an equal one: a fresh one re-renders every subscriber and
    // re-serializes the persist blob for a value that did not change.
    expect(activeRound()).toBe(capped);
  });

  it('ignores an unknown key', () => {
    useGameStore.getState().markRoundCapped('d:9:en');
    expect(useGameStore.getState().rounds['d:9:en']).toBeUndefined();
  });
});

describe('improveHole — closer word + lower rank, others untouched', () => {
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV));

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
  beforeEach(() => useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV));

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

// CONTRACT (#203): what a finished round persists is `recorded` — the SERVER holds this
// round's solve, read off a round answer rather than off the local board — which is what
// makes its score row (and therefore its standing) readable, and what says the round is
// frozen. It replaced the recorded SCORE, which existed to reconcile a client-claimed one;
// there is none left to reconcile. It targets the key captured when the request started,
// even if navigation has made a different round active by the time the answer lands.
describe('the server-held solve (#203) — markRoundRecorded', () => {
  it('marks the keyed round, and persists on the round itself', () => {
    const { ensureRound, markRoundRecorded } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    expect(activeRound()?.recorded).toBeUndefined();
    markRoundRecorded('d:5:fr');
    expect(activeRound()?.recorded).toBe(true);
    const before = useGameStore.getState().rounds;
    markRoundRecorded('d:5:fr');
    expect(useGameStore.getState().rounds).toBe(before); // idempotent — no churn
  });

  it('marks the round the answer is about, not the newly active one', () => {
    const { ensureRound, markRoundRecorded } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    ensureRound('d:6:fr', freshHoles(), REV); // the active round has moved on
    markRoundRecorded('d:5:fr');
    const s = useGameStore.getState();
    expect(s.rounds['d:5:fr'].recorded).toBe(true);
    expect(s.rounds['d:6:fr'].recorded).toBeUndefined();
  });

  it('survives a rehydration under the same key, and resets with a re-published sentence', () => {
    const { ensureRound, markRoundRecorded } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    markRoundRecorded('d:5:fr');
    // The same puzzle reconciles again (a reload): the flag survives, so the conversation
    // is not re-opened for a guaranteed refusal.
    useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV);
    expect(activeRound()?.recorded).toBe(true);
    // A re-published different sentence resets the round — the server's solve was about
    // the retired one.
    const changed = freshHoles().map((h) => ({ ...h, secret: `${h.secret}-x` }));
    useGameStore.getState().ensureRound('d:5:fr', changed, REV);
    expect(activeRound()?.recorded).toBeUndefined();
  });

  it('is a no-op for an unknown key', () => {
    const before = useGameStore.getState().rounds;
    useGameStore.getState().markRoundRecorded('d:999:fr');
    expect(useGameStore.getState().rounds).toBe(before);
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

// CONTRACT (#190, user feedback 2026-08-20): the board tab belongs to a VISIT. It is
// persisted so the two remounts that do NOT end a visit — a refresh and a header mode
// switch — keep it, and LEAVING the leaderboard resets it, so the next open is FRIENDS.
// App fires the reset on any non-board route; what is pinned here is that the reset
// exists and is idempotent.
describe('boardTab — the leaderboard tab, scoped to a visit', () => {
  it('holds the chosen tab, and reset returns it to the trusted default', () => {
    const { setBoardTab, resetBoardTab } = useGameStore.getState();
    expect(useGameStore.getState().boardTab).toBe('friends');
    setBoardTab('global');
    expect(useGameStore.getState().boardTab).toBe('global');
    resetBoardTab();
    expect(useGameStore.getState().boardTab).toBe('friends');
    // Idempotent: App calls it on EVERY non-board route, so it must not churn the blob.
    resetBoardTab();
    expect(useGameStore.getState().boardTab).toBe('friends');
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
      boardTab: 'friends',
      sentenceRulesSeen: false,
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
      boardTab: 'friends',
      sentenceRulesSeen: false,
      solvedDays: {},
    });
    expect('layout' in out).toBe(false);
    expect('routeSeen' in out).toBe(false);
  });

  it('v2 -> v3 adds an empty solvedDays and preserves lastLang/onboarded', () => {
    // The rounds themselves do NOT survive: any blob older than v13 predates the published
    // revision, so its sentence rounds are dropped (see migratePersisted).
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a', 'b'], progress: 10 } };
    const out = migratePersisted({ rounds, lastLang: 'fr', onboarded: true }, 2);
    expect(out).toEqual({
      rounds: {},
      wordRounds: {},
      lastLang: 'fr',
      lastMode: null,
      onboarded: true,
      boardTab: 'friends',
      sentenceRulesSeen: false,
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
      // Dropped: a pre-v13 blob carries no published revision (see migratePersisted).
      rounds: {},
      wordRounds: {},
      lastLang: 'fr',
      lastMode: null,
      onboarded: true,
      boardTab: 'friends',
      sentenceRulesSeen: false,
      solvedDays,
    });
  });

  // v5 -> v6 (#156): Word mode adds its own rounds map and the last-played mode. An
  // older blob gets an empty map + no preference.
  it('v5 -> v6 adds empty wordRounds + null lastMode', () => {
    const out = migratePersisted({ rounds: {}, lastLang: 'fr', onboarded: true, solvedDays: {} }, 5);
    expect(out.wordRounds).toEqual({});
    expect(out.lastMode).toBeNull();
  });

  // v6 -> v7 (#163): word rounds became TIMED. A v6 round recorded a STRIKE run — three
  // consecutive misses, no clock — and there is no honest clock to invent for it, so the
  // standing no-back-compat rule applies and every one of them is dropped. Nothing else
  // is: the sentence rounds, the solved days and the mode preference all survive, because
  // this change touched none of them.
  it('v6 -> v7 drops pre-clock word rounds and keeps everything else', () => {
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a'], progress: 10 } };
    const solvedDays = { fr: [10, 11] };
    const strikeRounds = { 'w:5:fr': { word: 'phare', tried: ['mer'], claimed: 1, ended: false } };
    const out = migratePersisted(
      { rounds, wordRounds: strikeRounds, lastLang: 'fr', lastMode: 'word', onboarded: true, solvedDays },
      6,
    );
    expect(out.wordRounds).toEqual({});
    // Sentence rounds go too, for v13's own reason — this blob predates the revision stamp.
    expect(out.rounds).toEqual({});
    expect(out).toMatchObject({ lastLang: 'fr', lastMode: 'word', onboarded: true, solvedDays });
  });

  // v10 -> v11 (#202): a word round's clock is the SERVER's stamp now. A v10 round's is a
  // local Date.now() no server ever saw — its end-of-run submission would be refused as
  // `not_started` and its clock is unauditable — so the v7 precedent applies again and
  // every one of them is dropped. Everything else survives untouched.
  it('v10 -> v11 drops locally-clocked word rounds and keeps everything else', () => {
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a'], progress: 10 } };
    const localRounds = {
      'w:5:fr': {
        word: 'phare',
        startedAt: 1_700_000_000_000,
        deadline: 1_700_000_066_000,
        tried: ['mer'],
        claimed: 1,
      },
    };
    const out = migratePersisted(
      {
        rounds,
        wordRounds: localRounds,
        lastLang: 'fr',
        lastMode: 'word',
        onboarded: true,
        solvedDays: { fr: [10] },
      },
      10,
    );
    expect(out.wordRounds).toEqual({});
    // And the sentence rounds go with them, for v13's own reason (no published revision).
    expect(out.rounds).toEqual({});
    expect(out).toMatchObject({ lastLang: 'fr', lastMode: 'word', solvedDays: { fr: [10] } });
  });

  // v12 -> v13 (#203): a sentence round stored before the published revision existed cannot
  // say WHICH version it was played against, and matching holes prove nothing about the maps
  // (rank 0 is a GROUP, so a correction moves aliases without touching a hole). The standing
  // no-back-compat rule applies, exactly as it did for v7's strike runs and v11's word
  // rounds — but the STREAK is a separate fact and survives, as it did there.
  it('v12 -> v13 drops pre-revision sentence rounds and keeps the streak', () => {
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a', 'b'], progress: 10 } };
    const wordRounds = { 'w:5:fr': { word: 'phare', startedAt: 1, deadline: 2, tried: [], claimed: 0 } };
    const solvedDays = { fr: [10, 11] };
    const out = migratePersisted(
      { rounds, wordRounds, lastLang: 'fr', onboarded: true, solvedDays },
      12,
    );
    expect(out.rounds).toEqual({});
    expect(out.wordRounds).toEqual(wordRounds);
    expect(out.solvedDays).toEqual(solvedDays);
  });

  it('grandfathers a veteran off the RAW blob, not the dropped rounds', () => {
    // `onboarded` asks whether this person has played before. Reading the post-drop map
    // would hand the tutorial back to every veteran whose only signal was their history.
    const rounds = { 'd:5:fr': { holes: freshHoles(), guessCount: 2, tried: ['a'], progress: 10 } };
    expect(migratePersisted({ rounds, lastLang: null }, 12).onboarded).toBe(true);
  });

  it('a v11 blob keeps its server-anchored word rounds untouched', () => {
    const wordRounds = {
      'w:5:fr': {
        word: 'phare',
        startedAt: 1_700_000_000_000,
        deadline: 1_700_000_066_000,
        tried: ['mer'],
        claimed: 1,
        submitted: true,
      },
    };
    const kept = migratePersisted(
      { rounds: {}, wordRounds, lastLang: 'fr', lastMode: 'word', onboarded: true, solvedDays: {} },
      11,
    );
    expect(kept.wordRounds).toEqual(wordRounds);
    expect(kept.lastMode).toBe('word');
  });

  // v7 -> v8 (2026-08-11): the sentence game's one-time instructions gate. Older blobs get
  // false — deliberately NOT grandfathered like `onboarded`: the gate teaches the history
  // tap, which is newer than any existing play state, so every player sees it exactly once.
  it('v7 -> v8 defaults sentenceRulesSeen to false and keeps an explicit true', () => {
    expect(
      migratePersisted({ rounds: {}, lastLang: 'fr', onboarded: true, solvedDays: {} }, 7)
        .sentenceRulesSeen,
    ).toBe(false);
    expect(
      migratePersisted(
        { rounds: {}, lastLang: 'fr', onboarded: true, sentenceRulesSeen: true, solvedDays: {} },
        8,
      ).sentenceRulesSeen,
    ).toBe(true);
  });

  // v8 -> v9 (2026-08-20): which #190 board tab is up. Older blobs get 'friends'
  // — the default the screen already opened on, so nobody's board moves under them; the
  // field only starts remembering from the first flip. An unknown value is not a tab.
  it('v8 -> v9 defaults boardTab to friends and keeps a stored global', () => {
    const blob = { rounds: {}, lastLang: 'fr', onboarded: true, solvedDays: {} };
    expect(migratePersisted(blob, 8).boardTab).toBe('friends');
    expect(migratePersisted({ ...blob, boardTab: 'global' }, 9).boardTab).toBe('global');
    expect(migratePersisted({ ...blob, boardTab: 'nonsense' }, 9).boardTab).toBe('friends');
  });

  // v11 -> v12 (#203): the retired scoreRecorded VALUE, on BOTH round maps. There is no
  // client-claimed score left to reconcile — the server derives it from the log it stores
  // and records the row itself — so a finished round persists only `recorded`, written from
  // a round answer. Stripped rather than translated (the v10 precedent): a sentence round
  // the population already holds re-learns it from its next mount READ, and a word round
  // already carries `submitted`. v10's own `scoreSubmitted` strip rides along, since a blob
  // older than that can carry both.
  it('v11 -> v12 strips scoreRecorded (and the older scoreSubmitted) from both round maps', () => {
    const out = migratePersisted(
      {
        rounds: {
          'd:5:fr': { roundKey: 'd:5:fr', holes: [], tried: [], progress: 0, scoreSubmitted: true },
          'd:6:fr': {
            roundKey: 'd:6:fr',
            holes: [],
            tried: [],
            progress: 0,
            scoreRecorded: 9,
          },
        },
        wordRounds: {
          'w:6:fr': {
            word: 'phare',
            startedAt: 1,
            deadline: 2,
            tried: [],
            claimed: 0,
            scoreRecorded: 12,
            submitted: true,
          },
        },
        lastLang: 'fr',
        onboarded: true,
        solvedDays: {},
      },
      11,
    );
    for (const round of Object.values(out.rounds)) {
      expect(round).not.toHaveProperty('scoreRecorded');
      expect(round).not.toHaveProperty('scoreSubmitted');
    }
    // The word round survives v11 intact APART from the retired value: its own
    // acknowledgement is what keeps it from re-submitting.
    expect(out.wordRounds['w:6:fr']).not.toHaveProperty('scoreRecorded');
    expect(out.wordRounds['w:6:fr'].submitted).toBe(true);
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

// CONTRACT (#203, user-decided 2026-08-22): a REPUBLISH means the puzzle contained an
// error, so the round it retires STARTS OVER. Its guesses were answers to a different
// question, and a corrected rank map can move the very aliases that decided whether a hole
// was solved — which the sentence's own shape cannot show, since a correction usually keeps
// the same holes.
describe('a republished puzzle resets its round (#203)', () => {
  const OTHER = 'b2c3d4e5f6071829';

  it('starts over when the published VERSION changed, even with identical holes', () => {
    const { ensureRound, recordGuess } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    recordGuess('bois');
    expect(useGameStore.getState().rounds['d:5:fr'].tried).toEqual(['bois']);

    // Same sentence, same holes — a corrected neighborhood.
    useGameStore.getState().ensureRound('d:5:fr', freshHoles(), OTHER);
    const round = useGameStore.getState().rounds['d:5:fr'];
    expect(round.tried).toEqual([]);
    expect(round.guessCount).toBe(0);
    expect(round.progress).toBe(0);
    expect(round.revision).toBe(OTHER);
  });

  it('rehydrates untouched when the version is the same', () => {
    const { ensureRound, recordGuess } = useGameStore.getState();
    ensureRound('d:5:fr', freshHoles(), REV);
    recordGuess('bois');
    useGameStore.getState().ensureRound('d:5:fr', freshHoles(), REV);
    expect(useGameStore.getState().rounds['d:5:fr'].tried).toEqual(['bois']);
  });

  it('RESETS a round stored with no revision rather than adopting it', () => {
    // The standing no-back-compat rule: v13 drops these at the migration, so one reaching
    // ensureRound is not a shape to accommodate. Matching holes prove nothing about the maps
    // either — rank 0 is a GROUP, so a correction can move the aliases that decide `solved`
    // without touching a hole.
    useGameStore.setState((s) => ({
      rounds: {
        ...s.rounds,
        'd:9:fr': { holes: freshHoles(), guessCount: 1, tried: ['bois'], progress: 12 },
      },
    }));
    useGameStore.getState().ensureRound('d:9:fr', freshHoles(), REV);
    const round = useGameStore.getState().rounds['d:9:fr'];
    expect(round.tried).toEqual([]);
    expect(round.guessCount).toBe(0);
    expect(round.revision).toBe(REV);
  });
});
