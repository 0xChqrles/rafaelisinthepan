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
//   - lastLang remembers the last valid language (seeds the `/` redirect).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  useGameStore,
  roundKeyForBonus,
  roundKeyForDay,
  migratePersisted,
  reconcileGameStateIdentity,
  roundLoadFor,
  persistedStateOf,
  initialPersistedState,
  applyGameMutation,
  type GameMutation,
} from './gameStore';
import { useHistoryStore } from './history';

// The published VERSION a round is played on (#203). Every call here plays ONE version;
// what a REPUBLISH does has its own suite below.
const REV = 'a1b2c3d4e5f60718';
const OWNER = { accountId: 'a'.repeat(16), deviceId: 'd'.repeat(16) };

beforeEach(() => {
  // Reset to a pristine store between tests (merge, keeping the actions).
  useGameStore.setState(
    {
      identityOwner: null,
      outbox: {},
      lastLang: null,
      onboarded: false,
      boardTab: 'group',
      lastGroupId: null,
      lessonsDone: [],
      roundLoads: {},
    },
    false,
  );
});

describe('roundKeyForDay', () => {
  it('is (day, lang) and matches the documented format', () => {
    expect(roundKeyForDay(5, 'fr')).toBe('d:5:fr');
    expect(roundKeyForDay(6, 'en')).toBe('d:6:en');
  });
});

// CONTRACT (#214): persistent storage is an OUTBOX. `ensureOutbox` reconciles it to the puzzle
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

  it('keeps a BONUS round\'s outbox beside the days\' — it is no legacy key', () => {
    const { ensureOutbox, appendOutbox } = useGameStore.getState();
    const bonusKey = roundKeyForBonus(1234567, 'fr');
    expect(bonusKey).toBe('b:1234567:fr');
    appendOutbox(bonusKey, REV, 'bois');
    ensureOutbox('d:5:fr', REV);
    appendOutbox('d:5:fr', REV, 'foret');
    expect(useGameStore.getState().outbox[bonusKey]?.guesses).toEqual(['bois']);
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

  it('keeps an old active archive round inside the cap rather than growing to 801', () => {
    const CAP = 800;
    const seeded: Record<string, { puzzle: string; guesses: string[] }> = {};
    for (let day = 2; day <= CAP + 1; day += 1) {
      seeded[`d:${day}:fr`] = { puzzle: REV, guesses: [`g${day}`] };
    }
    useGameStore.setState({ outbox: seeded }, false);

    useGameStore.getState().appendOutbox('d:1:fr', REV, 'archive');

    const outbox = useGameStore.getState().outbox;
    expect(Object.keys(outbox)).toHaveLength(CAP);
    expect(outbox['d:1:fr']?.guesses).toEqual(['archive']);
    expect(outbox['d:2:fr']).toBeUndefined();
    expect(outbox[`d:${CAP + 1}:fr`]).toBeDefined();
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
  const server = {
    guesses: ['bois'],
    solved: false,
    gaveUp: false,
    solvedByAppend: false,
    credited: false,
  };
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

  it('is NOT persisted — the persisted projection carries no round loads', () => {
    useGameStore.getState().setRoundLoad('d:5:fr', { status: 'ready', puzzle, server });
    const persisted = persistedStateOf(useGameStore.getState());
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
// switch — keep it, and LEAVING the leaderboard resets it, so the next open is the GROUP.
// App fires the reset on any non-board route; what is pinned here is that the reset
// exists and is idempotent.
describe('boardTab — the leaderboard tab, scoped to a visit', () => {
  it('holds the chosen tab, and reset returns it to the trusted default', () => {
    const { setBoardTab, resetBoardTab } = useGameStore.getState();
    expect(useGameStore.getState().boardTab).toBe('group');
    setBoardTab('global');
    expect(useGameStore.getState().boardTab).toBe('global');
    resetBoardTab();
    expect(useGameStore.getState().boardTab).toBe('group');
    // Idempotent: App calls it on EVERY non-board route, so it must not churn the blob.
    resetBoardTab();
    expect(useGameStore.getState().boardTab).toBe('group');
  });

  // The group last opened (#271) OUTLIVES the visit — the result's boards open on it — and it
  // belongs to the ACCOUNT: leaving one drops it.
  it('remembers the group last opened, and drops it with the account', () => {
    const { setLastGroup } = useGameStore.getState();
    expect(useGameStore.getState().lastGroupId).toBeNull();
    setLastGroup('abcdefghij234567');
    expect(useGameStore.getState().lastGroupId).toBe('abcdefghij234567');
    const owner = { accountId: 'lfd5pqz5pa7zjm5u', deviceId: 'd'.repeat(16) };
    useGameStore.setState({ identityOwner: owner }, false);
    const moved = applyGameMutation(persistedStateOf(useGameStore.getState()), {
      type: 'reconcileIdentity',
      expectedOwner: owner,
      identity: { accountId: 'nq2yv6cme4jkbhtx', deviceId: 'd'.repeat(16) },
      pendingBootstrap: false,
    });
    expect(moved.state.lastGroupId).toBeNull();
  });
});

describe('onboarded — the tutorial flag (#51)', () => {
  it('setOnboarded marks the tutorial seen (finish AND skip both call it)', () => {
    expect(useGameStore.getState().onboarded).toBe(false);
    useGameStore.getState().setOnboarded();
    expect(useGameStore.getState().onboarded).toBe(true);
  });
});

describe('lessonsDone — the levels this device has done (#269)', () => {
  it('markLessonDone is idempotent and keeps the list a sorted set', () => {
    const { markLessonDone } = useGameStore.getState();
    markLessonDone(2);
    markLessonDone(1);
    markLessonDone(2);
    expect(useGameStore.getState().lessonsDone).toEqual([1, 2]);
  });
});

describe('migratePersisted — persisted-blob upgrades', () => {
  it('discards a v0 blob entirely (one-time reset)', () => {
    expect(migratePersisted({ roundKey: 'x', holes: [] }, 0)).toEqual({
      identityOwner: null,
      outbox: {},
      lastLang: null,
      onboarded: false,
      boardTab: 'group',
      lastGroupId: null,
      lessonsDone: [],
      localSeed: null,
    });
  });

  it('fails closed on a corrupt current-version record instead of crashing hydration', () => {
    expect(migratePersisted(null, 18)).toEqual(initialPersistedState());
    const out = migratePersisted(
      {
        identityOwner: OWNER,
        outbox: { 'd:5:fr': { puzzle: REV, guesses: 'not-an-array' } },
        lastLang: 'de',
      },
      18,
    );
    expect(out).toMatchObject({ identityOwner: OWNER, outbox: {}, lastLang: null });
  });

  it('keeps an explicit onboarded value over the grandfathering inference', () => {
    expect(migratePersisted({ lastLang: 'fr', onboarded: false }, 20).onboarded).toBe(false);
  });

  it('infers onboarded from a stored language when the flag is missing', () => {
    expect(migratePersisted({ lastLang: 'fr' }, 20).onboarded).toBe(true);
    expect(migratePersisted({ lastLang: null }, 20).onboarded).toBe(false);
  });

  it('drops the retired Word mode\u2019s rounds and mode preference from a current blob', () => {
    const outbox = { 'd:5:fr': { puzzle: REV, guesses: ['bois'] } };
    const out = migratePersisted(
      {
        identityOwner: OWNER,
        outbox,
        wordRounds: { 'w:5:fr': { word: 'phare', startedAt: 1, deadline: 2, tried: [], claimed: 0 } },
        lastLang: 'fr',
        lastMode: 'word',
        onboarded: true,
      },
      19,
    );
    expect(out).not.toHaveProperty('wordRounds');
    expect(out).not.toHaveProperty('lastMode');
    expect(out).toMatchObject({ identityOwner: OWNER, outbox, lastLang: 'fr', onboarded: true });
  });

  it('drops an outbox that cannot name the identity that owns it', () => {
    const outbox = { 'd:5:fr': { puzzle: REV, guesses: ['bois'] } };
    const out = migratePersisted({ outbox, lastLang: 'fr', onboarded: true }, 20);
    expect(out.outbox).toEqual({});
    expect(out.identityOwner).toBeNull();
  });

  // v19 -> v20 (#269): the rules gate's `sentenceRulesSeen` is RETIRED (dropped, not
  // translated — the standing no-back-compat rule) and `lessonsDone` arrives: older blobs
  // start with no level done, and a stored list survives only as a sorted set of levels.
  it('v19 -> v20 drops sentenceRulesSeen and reads lessonsDone as a sorted set of levels', () => {
    const blob = { outbox: {}, lastLang: 'fr', onboarded: true, sentenceRulesSeen: true };
    const out = migratePersisted(blob, 19);
    expect(out.lessonsDone).toEqual([]);
    expect('sentenceRulesSeen' in out).toBe(false);
    expect(
      migratePersisted({ ...blob, lessonsDone: [3, 1, 1, 0, -2, 'x', 2.5] }, 20).lessonsDone,
    ).toEqual([1, 3]);
    expect(migratePersisted({ ...blob, lessonsDone: 'nope' }, 20).lessonsDone).toEqual([]);
  });

  // Which #190 board tab is up: a blob without one gets the group tab, the default the
  // screen opens on, and an unknown value is not a tab.
  it('defaults boardTab to the group tab and keeps a stored global (v19 renamed it)', () => {
    const blob = { lastLang: 'fr', onboarded: true };
    expect(migratePersisted(blob, 20).boardTab).toBe('group');
    expect(migratePersisted({ ...blob, boardTab: 'global' }, 20).boardTab).toBe('global');
    expect(migratePersisted({ ...blob, boardTab: 'nonsense' }, 20).boardTab).toBe('group');
    // v18 -> v19: the retired 'friends' reads as the default, and a stored group survives
    // only when it is a group id.
    expect(migratePersisted({ ...blob, boardTab: 'friends' }, 18).boardTab).toBe('group');
    expect(migratePersisted({ ...blob, lastGroupId: 'abcdefghij234567' }, 19).lastGroupId).toBe('abcdefghij234567');
    expect(migratePersisted({ ...blob, lastGroupId: 'NOPE' }, 19).lastGroupId).toBeNull();
  });
});

describe('persisted state ownership (#216)', () => {
  const outbox = { 'd:5:fr': { puzzle: REV, guesses: ['bois'] } };

  it('drops tagged state when the device key is missing instead of bootstrapping a new owner', () => {
    useGameStore.setState({ identityOwner: OWNER, outbox });
    reconcileGameStateIdentity(null, false);
    expect(useGameStore.getState()).toMatchObject({ identityOwner: null, outbox: {} });
  });

  it('keeps ownerless state only behind the pending token minted by its deliberate act', () => {
    useGameStore.setState({ identityOwner: null, outbox });
    reconcileGameStateIdentity(null, true);
    expect(useGameStore.getState().outbox).toEqual(outbox);

    reconcileGameStateIdentity(null, false);
    expect(useGameStore.getState().outbox).toEqual({});
  });

  it('binds a recovered ownerless first act to the identity its bootstrap returned', () => {
    useGameStore.setState({ identityOwner: null, outbox });
    reconcileGameStateIdentity(OWNER);
    expect(useGameStore.getState().identityOwner).toEqual(OWNER);
    expect(useGameStore.getState().outbox).toEqual(outbox);
  });

  it('keeps the account-owned outbox when only the device changed', () => {
    useGameStore.setState({ identityOwner: OWNER, outbox });
    const replacement = { ...OWNER, deviceId: 'q'.repeat(16) };
    reconcileGameStateIdentity(replacement);
    expect(useGameStore.getState().identityOwner).toEqual(replacement);
    expect(useGameStore.getState().outbox).toEqual(outbox);
  });

  it('a mutation naming another owner changes nothing', () => {
    // A late write from account A must not touch a state a sibling tab rebound to B.
    const other = { accountId: 'b'.repeat(16), deviceId: 'e'.repeat(16) };
    const state = { ...initialPersistedState(), identityOwner: other, outbox, lastGroupId: 'abcdefghij234567' };
    const stale: GameMutation[] = [
      { type: 'ensureOutbox', key: 'd:5:fr', puzzle: 'b2c3d4e5f6071829', expectedOwner: OWNER },
      { type: 'appendOutbox', key: 'd:5:fr', puzzle: REV, typed: 'late', expectedOwner: OWNER },
      { type: 'settleOutbox', key: 'd:5:fr', puzzle: REV, before: ['bois'], after: [], expectedOwner: OWNER },
      { type: 'discardOutbox', key: 'd:5:fr', puzzle: REV, expectedOwner: OWNER },
      { type: 'reconcileIdentity', expectedOwner: OWNER, identity: null, pendingBootstrap: false },
    ];
    for (const mutation of stale) {
      const result = applyGameMutation(state, mutation);
      expect(result.changed, mutation.type).toBe(false);
      expect(result.state, mutation.type).toBe(state);
    }
  });
});

// CONTRACT (#203, user-decided 2026-08-22; reshaped by #214): a REPUBLISH means the puzzle
// contained an error, so the round it retires STARTS OVER. Its guesses were answers to a
// different question, and a corrected rank map can move the very aliases that decided
// whether a hole was solved — which the sentence's own shape cannot show, since a correction
// usually keeps the same holes. What starts over locally is now the OUTBOX; the SERVER's log
// restarts on the same revision comparison.
describe('a republished puzzle resets its round (#203/#214)', () => {
  const OTHER = 'b2c3d4e5f6071829';

  afterEach(() => {
    useHistoryStore.setState({ months: {}, solved: {} }, true);
  });

  it('leaves the SOLVED-DAY credit alone — a republish is the publisher\'s error', () => {
    // The streak rewards showing up, and taking a day back because we shipped a broken
    // puzzle would punish the player for it. The credit is the SERVER's since #211, and the
    // reset knows only about the outbox — so no local path can take a day back on a
    // republish. (That a corrected version cannot claim the day TWICE is `noteSolvedDay`'s
    // own rule; see state/history.test.ts.)
    useHistoryStore.setState({ solved: { fr: { phase: 'ready', days: [5] } } }, false);
    useGameStore.getState().ensureOutbox('d:5:fr', OTHER);
    expect(useHistoryStore.getState().solved.fr?.days).toEqual([5]);
  });
});

// CONTRACT (#207): an account DELETED by its own player leaves a brand-new visitor behind —
// the whole persisted record forgotten (the outbox, its owner, the preferences, the tutorial's
// progress) and a NEW placeholder seed, so the next account never wears the deleted one's
// face. Owner-blind: the account that owned the outbox exists nowhere any more.
describe('forgetAll (#207)', () => {
  const lived = {
    ...initialPersistedState(),
    identityOwner: OWNER,
    outbox: { [roundKeyForDay(5, 'fr')]: { puzzle: REV, guesses: ['chat'] } },
    lastLang: 'fr',
    onboarded: true,
    boardTab: 'global' as const,
    lastGroupId: 'g'.repeat(16),
    lessonsDone: [1],
    localSeed: 'a'.repeat(16),
  };

  it('returns the initial state under a NEW seed, whatever was held', () => {
    const seed = 'b'.repeat(16);
    const result = applyGameMutation(lived, { type: 'forgetAll', seed });
    expect(result.changed).toBe(true);
    expect(result.state).toEqual({ ...initialPersistedState(), localSeed: seed });
  });

  it('the store method commits it and drops the transient round states', () => {
    useGameStore.setState({ ...lived, roundLoads: { [roundKeyForDay(5, 'fr')]: { status: 'loading', puzzle: REV } as never } });
    useGameStore.getState().forgetAll();
    const state = useGameStore.getState();
    expect(persistedStateOf(state)).toEqual({ ...initialPersistedState(), localSeed: state.localSeed });
    expect(state.localSeed).not.toBeNull();
    expect(state.localSeed).not.toBe(lived.localSeed);
    expect(state.roundLoads).toEqual({});
  });
});
