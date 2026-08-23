// CONTRACT: the day-keyed round store (packages/web/src/state/gameStore.ts). Since #214 a
// SENTENCE round persists only an OUTBOX — the guesses the server has not acknowledged,
// qualified by the published revision — while its authoritative state lives in memory:
//   - an outbox is KEPT across days so an archive day left offline still owes its guesses;
//     any legacy non-day key is dropped, and the map is bounded by the MAX_DAY_ROUNDS
//     most-recent cap (oldest evicted beyond it);
//   - switching LANGUAGE keeps BOTH outboxes — coming back still owes what it owed;
//   - the SAME key + published revision keeps the outbox untouched (a mid-round reload); a
//     new revision DROPS it, since its guesses answered a retired question;
//   - an emptied outbox is REMOVED — a caught-up device persists no sentence round at all;
//   - `roundLoads` is transient by construction, never persisted;
//   - WORD rounds persist their clock and unacknowledged run log; an accepted server log
//     clears that outbox and lives in the transient round load;
//   - lastLang remembers the last valid language (seeds the `/` redirect).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGameStore, roundKeyForDay, migratePersisted, roundLoadFor } from './gameStore';

// The published VERSION a round is played on (#203). Every call here plays ONE version;
// what a REPUBLISH does has its own suite below.
const REV = 'a1b2c3d4e5f60718';
import { CLAIM_ZONE, runMs } from '../game/wordGame';
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

beforeEach(() => {
  // Reset to a pristine store between tests (merge, keeping the actions).
  useGameStore.setState(
    {
      outbox: {},
      wordRounds: {},
      lastLang: null,
      lastMode: null,
      onboarded: false,
      boardTab: 'friends',
      sentenceRulesSeen: false,
      solvedDays: {},
      roundLoads: {},
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
    const { appendOutbox, ensureWordRound } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
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
    // The sentence round is untouched — the two dailies' state never collide.
    expect(s.outbox['d:5:fr']?.guesses).toEqual(['bois']);
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

  // #214: the server's RECORDED run is authoritative, while persisted `tried` is only the
  // submission outbox. A successful answer therefore clears it and keeps the server log
  // in the transient round load instead.
  it('settleWordRun clears the acknowledged outbox and takes the authoritative count', () => {
    const { ensureWordRound, anchorWordRun, recordWordGuess, settleWordRun } =
      useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', T0);
    recordWordGuess('mer', priced(3));
    expect(wordRound().deadline).toBeGreaterThan(T0);

    // Another device's first write can contain a different run. Its count wins, and the
    // local live phase ends at settlement instead of leaving an input that cannot write.
    settleWordRun('w:5:fr', 2);
    expect(wordRound()).toMatchObject({
      tried: [],
      claimed: 2,
      deadline: T0,
      submitted: true,
    });
  });

  it('settlement never moves an already-ended deadline forward', () => {
    const { ensureWordRound, anchorWordRun, settleWordRun } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', T0 - runMs(0) - 1);
    const deadline = wordRound().deadline;

    settleWordRun('w:5:fr', 0);

    expect(wordRound()).toMatchObject({ deadline, submitted: true });
  });

  it('settles a recorded empty run and is idempotent', () => {
    const { ensureWordRound, settleWordRun } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    expect(wordRound().submitted).toBeUndefined();
    settleWordRun('w:5:fr', 0);
    const after = wordRound();
    expect(after).toMatchObject({ tried: [], claimed: 0, submitted: true });
    settleWordRun('w:5:fr', 0);
    expect(wordRound()).toBe(after); // no second write, so nothing re-serializes
  });

  it('clamps the persisted authoritative count to the finite claim field', () => {
    const { ensureWordRound, settleWordRun } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');

    // The normal caller derives this from replayWordRun and can never exceed the zone.
    // The store still owns the persisted summary invariant: archive/chooser progress must
    // remain bounded even if corrupt server state crosses that caller boundary.
    settleWordRun('w:5:fr', CLAIM_ZONE + 1);

    expect(wordRound()).toMatchObject({ tried: [], claimed: CLAIM_ZONE, submitted: true });
    const settled = wordRound();
    settleWordRun('w:5:fr', CLAIM_ZONE + 2);
    expect(wordRound()).toBe(settled); // equal after clamping, so no redundant persist write
  });

  it('makes a non-finite authoritative count a safe persisted summary', () => {
    const { ensureWordRound, settleWordRun } = useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');

    settleWordRun('w:5:fr', Number.NaN);

    expect(wordRound()).toMatchObject({ tried: [], claimed: 0, submitted: true });
  });

  it('takes no guesses after the server has settled the run', () => {
    const { ensureWordRound, anchorWordRun, settleWordRun, recordWordGuess } =
      useGameStore.getState();
    ensureWordRound('w:5:fr', 'phare');
    anchorWordRun('w:5:fr', T0);
    settleWordRun('w:5:fr', 1);

    expect(recordWordGuess('mer', priced(3))).toBe(false);
    expect(wordRound()).toMatchObject({ tried: [], claimed: 1, submitted: true });
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

// CONTRACT (#214): local storage is an OUTBOX. `ensureOutbox` reconciles it to the puzzle
// being played, `appendOutbox` buffers a guess the board has already reacted to, and
// `setOutbox` is how the sync engine writes back what an answer left unacknowledged. There
// are no holes, no counts, no cached progress and no server-fact flags in storage at all —
// the play log projects them from (server state + outbox), which is why nothing here has to
// be reconciled with anything.
describe('ensureOutbox — day/language keying, qualified by the published revision', () => {
  it('CREATES nothing — an outbox exists only while this device owes something', () => {
    // Every round between an accepted write and the next guess owes nothing, so persisting
    // an empty entry for it would put a sentence round back in storage for no reason.
    useGameStore.getState().ensureOutbox('d:5:fr', REV);
    expect(useGameStore.getState().outbox['d:5:fr']).toBeUndefined();
  });

  it('KEEPS an unsent outbox for the SAME key and revision (a mid-round reload)', () => {
    const { ensureOutbox, appendOutbox } = useGameStore.getState();
    ensureOutbox('d:5:fr', REV);
    appendOutbox('d:5:fr', REV, 'bois');
    ensureOutbox('d:5:fr', REV);
    expect(useGameStore.getState().outbox['d:5:fr']).toEqual({ puzzle: REV, guesses: ['bois'] });
  });

  it('DROPS an outbox naming a different published revision', () => {
    // A republish means the puzzle contained an error, so the round starts over: what the
    // outbox holds are answers to a retired question, and a corrected rank map can move the
    // aliases that decided whether a hole was solved.
    const { ensureOutbox, appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    ensureOutbox('d:5:fr', 'ffffffffffffffff');
    expect(useGameStore.getState().outbox['d:5:fr']).toBeUndefined();
  });

  it('KEEPS other days\' outboxes — an archive day left offline still owes its guesses', () => {
    const { ensureOutbox, appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    ensureOutbox('d:6:fr', REV);
    expect(useGameStore.getState().outbox['d:5:fr']?.guesses).toEqual(['bois']);
  });

  it('keeps both languages — switching away and back keeps what each still owes', () => {
    const { ensureOutbox, appendOutbox } = useGameStore.getState();
    ensureOutbox('d:5:fr', REV);
    appendOutbox('d:5:fr', REV, 'bois');
    ensureOutbox('d:5:en', REV);
    appendOutbox('d:5:en', REV, 'wood');
    ensureOutbox('d:5:fr', REV);
    expect(useGameStore.getState().outbox['d:5:fr']?.guesses).toEqual(['bois']);
    expect(useGameStore.getState().outbox['d:5:en']?.guesses).toEqual(['wood']);
  });

  it('drops a legacy non-day key while keeping the day ones', () => {
    useGameStore.setState(
      {
        outbox: {
          'o:legacy:fr': { puzzle: REV, guesses: ['x'] },
          'd:4:fr': { puzzle: REV, guesses: ['y'] },
        },
      },
      false,
    );
    useGameStore.getState().ensureOutbox('d:5:fr', REV);
    expect(useGameStore.getState().outbox['o:legacy:fr']).toBeUndefined();
    expect(useGameStore.getState().outbox['d:4:fr']?.guesses).toEqual(['y']);
  });

  it('caps the map: beyond MAX_DAY_ROUNDS the oldest days are evicted, the newest kept', () => {
    const CAP = 800;
    const seeded: Record<string, { puzzle: string; guesses: string[] }> = {};
    for (let day = 1; day <= CAP; day += 1) {
      seeded[`d:${day}:fr`] = { puzzle: REV, guesses: [`g${day}`] };
    }
    useGameStore.setState({ outbox: seeded }, false);
    // The active key's own guess is what puts it in the map; the cap must never evict it.
    useGameStore.getState().appendOutbox(`d:${CAP + 1}:fr`, REV, 'new');
    useGameStore.getState().ensureOutbox(`d:${CAP + 1}:fr`, REV);
    const s = useGameStore.getState();
    expect(s.outbox['d:1:fr']).toBeUndefined(); // oldest evicted
    expect(s.outbox['d:2:fr']?.guesses).toEqual(['g2']); // next-oldest survives
    expect(s.outbox[`d:${CAP + 1}:fr`]?.guesses).toEqual(['new']);
  });
});

describe('appendOutbox — the write buffer behind an instant board', () => {
  it('appends in the order typed, minting the outbox on the first guess', () => {
    const { appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    appendOutbox('d:5:fr', REV, 'foret');
    expect(useGameStore.getState().outbox['d:5:fr']).toEqual({
      puzzle: REV,
      guesses: ['bois', 'foret'],
    });
  });

  it('RECORDS a guess after an accepted write emptied the round\'s outbox', () => {
    // Found on the real board: an accepted write REMOVES the entry it emptied, so most
    // guesses of a round arrive with nothing to append into. Refusing there dropped every
    // guess after the first — the board reverted on the next replay and the server never
    // heard about them again.
    const { appendOutbox, setOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    setOutbox('d:5:fr', REV, []); // the write landed
    expect(useGameStore.getState().outbox['d:5:fr']).toBeUndefined();
    appendOutbox('d:5:fr', REV, 'foret');
    expect(useGameStore.getState().outbox['d:5:fr']).toEqual({ puzzle: REV, guesses: ['foret'] });
  });

  it('starts over rather than appending onto a RETIRED revision', () => {
    const { appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', 'ffffffffffffffff', 'bois');
    appendOutbox('d:5:fr', REV, 'foret');
    expect(useGameStore.getState().outbox['d:5:fr']).toEqual({ puzzle: REV, guesses: ['foret'] });
  });

  it('does NOT dedupe — the play log owns identity, and the store holds no rank map', () => {
    // Game deduplicates against the play log before calling this; the store must not
    // second-guess it with a raw string comparison that #104's aliases would defeat.
    const { appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    appendOutbox('d:5:fr', REV, 'bois');
    expect(useGameStore.getState().outbox['d:5:fr']?.guesses).toEqual(['bois', 'bois']);
  });

});

describe('setOutbox — what an answer left unacknowledged', () => {
  beforeEach(() => {
    const { appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    appendOutbox('d:5:fr', REV, 'foret');
  });

  it('replaces the guesses with what is still owed', () => {
    useGameStore.getState().setOutbox('d:5:fr', REV, ['foret']);
    expect(useGameStore.getState().outbox['d:5:fr']).toEqual({ puzzle: REV, guesses: ['foret'] });
  });

  it('REMOVES the entry when nothing is left — a caught-up device stores no rounds', () => {
    useGameStore.getState().setOutbox('d:5:fr', REV, []);
    expect(useGameStore.getState().outbox['d:5:fr']).toBeUndefined();
  });

  it('ignores an answer about a RETIRED revision', () => {
    // The republish already dropped this outbox; resurrecting the old guesses into the round
    // that replaced it is the one thing the revision exists to prevent.
    useGameStore.getState().ensureOutbox('d:5:fr', 'ffffffffffffffff');
    useGameStore.getState().setOutbox('d:5:fr', REV, ['bois', 'foret']);
    expect(useGameStore.getState().outbox['d:5:fr']).toBeUndefined();
  });

  it('ignores an unknown key (the round was evicted mid-flight)', () => {
    const before = useGameStore.getState().outbox;
    useGameStore.getState().setOutbox('d:999:fr', REV, ['bois']);
    expect(useGameStore.getState().outbox).toBe(before);
  });
});

// CONTRACT (#214): where a round's AUTHORITATIVE state is, held only in memory. The screen
// waits on it before it becomes interactive, so the three states have to be distinguishable
// — and it is NEVER persisted, which is what removes the acknowledged-derived state the
// outbox model exists to be rid of.
describe('setRoundLoad — the transient server state', () => {
  const server = { guesses: ['bois'], solved: false, solvedByAppend: false };
  const puzzle = REV;

  it('holds each round\'s state under its own key', () => {
    const { setRoundLoad } = useGameStore.getState();
    setRoundLoad('d:5:fr', { status: 'loading', puzzle });
    setRoundLoad('d:6:fr', { status: 'ready', puzzle, server });
    const s = useGameStore.getState();
    expect(s.roundLoads['d:5:fr']).toEqual({ status: 'loading', puzzle });
    expect(s.roundLoads['d:6:fr']).toEqual({ status: 'ready', puzzle, server });
  });

  it('FORGETS a round on null — the flight that owned the state was evicted', () => {
    const { setRoundLoad } = useGameStore.getState();
    setRoundLoad('d:5:fr', { status: 'ready', puzzle, server });
    setRoundLoad('d:5:fr', null);
    expect(useGameStore.getState().roundLoads['d:5:fr']).toBeUndefined();
  });

  it('forgetting an unknown key writes NOTHING', () => {
    const before = useGameStore.getState().roundLoads;
    useGameStore.getState().setRoundLoad('d:999:fr', null);
    expect(useGameStore.getState().roundLoads).toBe(before);
  });

  it('is NOT persisted — the partialize snapshot carries no round loads', () => {
    useGameStore.getState().setRoundLoad('d:5:fr', { status: 'ready', puzzle, server });
    const persisted = useGameStore.persist.getOptions().partialize!(useGameStore.getState());
    expect(persisted).not.toHaveProperty('roundLoads');
    expect(persisted).toHaveProperty('outbox');
  });

  it('treats a cached state for a retired puzzle as loading before effects run', () => {
    const ready = { status: 'ready', puzzle, server } as const;
    expect(roundLoadFor(ready, puzzle)).toBe(ready);
    expect(roundLoadFor(ready, 'ffffffffffffffff')).toEqual({
      status: 'loading',
      puzzle: 'ffffffffffffffff',
    });
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
      outbox: {},
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
      outbox: {},
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
      outbox: {},
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
      // Dropped: v14 removed the sentence rounds map, and no older blob can say which of
      // its guesses were still unsent (see migratePersisted).
      outbox: {},
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
    // The sentence rounds map is gone outright at v14, so nothing survives it either.
    expect(out.outbox).toEqual({});
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
    // And the sentence rounds go with them: v14 removed the map they lived in.
    expect(out.outbox).toEqual({});
    expect(out).toMatchObject({ lastLang: 'fr', lastMode: 'word', solvedDays: { fr: [10] } });
  });

  // v13 -> v14 (#214): the sentence `rounds` map is DROPPED outright — local storage is an
  // outbox now. There is nothing to translate: a stored round's UNSENT guesses were never
  // distinguishable from its acknowledged ones inside one merged `tried` list, so seeding an
  // outbox from it would re-send guesses the server already holds, burn cap slots on
  // duplicates and — near the cap — cost an honest player their leaderboard entry. The mount
  // READ recovers what the server has. The streak, the word rounds and every preference
  // survive, exactly as they did at v7, v11 and v13.
  it('v13 -> v14 drops the sentence rounds map and starts the outbox empty', () => {
    const rounds = {
      'd:5:fr': { holes: [], guessCount: 2, tried: ['a', 'b'], progress: 10, revision: REV },
    };
    const wordRounds = { 'w:5:fr': { word: 'phare', startedAt: 1, deadline: 2, tried: [], claimed: 0 } };
    const solvedDays = { fr: [10, 11] };
    const out = migratePersisted(
      { rounds, wordRounds, lastLang: 'fr', onboarded: true, solvedDays },
      13,
    );
    expect(out).not.toHaveProperty('rounds');
    expect(out.outbox).toEqual({});
    expect(out.wordRounds).toEqual(wordRounds);
    expect(out.solvedDays).toEqual(solvedDays);
  });

  it('keeps a v14 outbox untouched — it holds only what the server has not acknowledged', () => {
    const outbox = { 'd:5:fr': { puzzle: REV, guesses: ['bois'] } };
    const out = migratePersisted({ outbox, lastLang: 'fr', onboarded: true }, 14);
    expect(out.outbox).toEqual(outbox);
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
    // The sentence rounds those flags rode on are gone entirely at v14.
    expect(out).not.toHaveProperty('rounds');
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

// CONTRACT (#203, user-decided 2026-08-22; reshaped by #214): a REPUBLISH means the puzzle
// contained an error, so the round it retires STARTS OVER. Its guesses were answers to a
// different question, and a corrected rank map can move the very aliases that decided
// whether a hole was solved — which the sentence's own shape cannot show, since a correction
// usually keeps the same holes. What starts over locally is now the OUTBOX; the SERVER's log
// restarts on the same revision comparison.
describe('a republished puzzle resets its round (#203/#214)', () => {
  const OTHER = 'b2c3d4e5f6071829';

  it('drops the unsent guesses when the published VERSION changed', () => {
    const { ensureOutbox, appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    expect(useGameStore.getState().outbox['d:5:fr']?.guesses).toEqual(['bois']);

    // Same sentence, same holes — a corrected neighborhood.
    ensureOutbox('d:5:fr', OTHER);
    expect(useGameStore.getState().outbox['d:5:fr']).toBeUndefined();
  });

  it('keeps them untouched when the version is the same', () => {
    const { ensureOutbox, appendOutbox } = useGameStore.getState();
    appendOutbox('d:5:fr', REV, 'bois');
    ensureOutbox('d:5:fr', REV);
    expect(useGameStore.getState().outbox['d:5:fr']?.guesses).toEqual(['bois']);
  });

  it('leaves the SOLVED-DAY credit alone — a republish is the publisher\'s error', () => {
    // The streak rewards showing up, and taking a day back because we shipped a broken
    // puzzle would punish the player for it. `recordSolve` already refuses a day it holds,
    // so solving the correction cannot claim it twice.
    useGameStore.setState({ solvedDays: { fr: [5] } }, false);
    useGameStore.getState().ensureOutbox('d:5:fr', OTHER);
    expect(useGameStore.getState().solvedDays.fr).toEqual([5]);
  });
});
