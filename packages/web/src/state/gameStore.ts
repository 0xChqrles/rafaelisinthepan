import { create } from 'zustand';
import { generatePublicId, GROUP_ID_PATTERN, PUBLIC_ID_PATTERN } from '@whippin/shared';
import { isLang } from '../langs';
import {
  GameStateDatabase,
  type StoredGameState,
} from './gamePersistence';

// Which crowd the #190 leaderboard is showing: a GROUP (the trusted default, #271)
// or the global top 50. It lives here rather than in the screen because the screen
// remounts under it without the visit ending — see `boardTab` below.
export type BoardTab = 'group' | 'global';

// A round is identified by its `roundKey` = (server day, language).
//
// **Local storage stopped mirroring a sentence round at #214.** It used to hold a whole
// materialized view — the holes, the try count, the cached reconstruction %, the counted
// log, and flags saying what the server had on record — and every one of those was a second
// answer to a question the server already answers, which is what made reconciliation a
// permanent problem. What is persisted now is an OUTBOX: the guesses this device has typed
// and the server has NOT acknowledged, and nothing else. Everything else is either the
// server's (held transiently, below) or a pure projection of the two (`game/playLog.ts`).
export interface RoundOutbox {
  // WHICH PUBLISHED VERSION these guesses answer (#203's `revision`). A republish means
  // the puzzle contained an error, so a mismatched outbox is DROPPED rather than sent: its
  // guesses answered a different question, and a corrected rank map can move the very
  // aliases that decided whether a hole was solved.
  puzzle: string;
  // Folded guesses, in the order they were typed. Deduplicated against the play log on the
  // way in, so an inflection of something already played never enters it.
  guesses: string[];
}

// The SERVER's own state for one round, as of its last answer — the authoritative RAW
// ordered log plus what the server derived from it (#203). Held in MEMORY only: persisting
// it would recreate exactly the acknowledged-derived-state the outbox model removes.
export interface RoundServer {
  // The RAW stored log. Its LENGTH is what the storage cap counts (`ROUND_GUESS_CAP`) —
  // never the play log's, which the merge can leave shorter.
  guesses: string[];
  // Has the server read this log as solved? Only ever written true, so `false` means "not
  // yet". It is the authority for the round being over: the local board flips a beat
  // earlier, while the solving append is still in flight.
  solved: boolean;
  // Was this solve CONFIRMED by a batch this device just sent, rather than learned from the
  // mount read or a `round_solved` refusal? A solve this device played earns the normal
  // beats; an adopted one is history — shown, never celebrated.
  solvedByAppend: boolean;
  // Did the confirming answer say the solve EARNED the day — the streak credit and the
  // leaderboard row (#211's one on-time predicate, decided on the SERVER's clock)? The
  // celebration reads this instead of comparing days on the device clock, which the
  // route's skew window lets disagree with the server's by a day.
  credited: boolean;
}

// Where a round's authoritative state is, for the ONE screen that has to wait on it. The
// game is deliberately network-dependent since #214: it may not become interactive from a
// guessed local mirror, so a failed read is a visible state rather than permission to
// start.
export type RoundLoad =
  | { status: 'loading'; puzzle: string }
  | { status: 'failed'; puzzle: string }
  | { status: 'ready'; puzzle: string; server: RoundServer };

// A round key is only (day, language), so a corrected puzzle can reuse it while a
// passive effect has not yet registered the replacement with the sync engine. Never hand
// that first render the retired puzzle's cached READY state: until THIS identity settles,
// its honest state is loading.
export function roundLoadFor(load: RoundLoad | undefined, puzzle: string): RoundLoad {
  return load?.puzzle === puzzle ? load : { status: 'loading', puzzle };
}

// The server state a round with no stored record starts from — a 404 is "nothing yet",
// which is an answer, not a failure.
export const EMPTY_ROUND_SERVER: RoundServer = {
  guesses: [],
  solved: false,
  solvedByAppend: false,
  credited: false,
};

// The canonical round key: (server day, language). Kept here so the game screen (which
// builds it) and the sync engine (which keys its conversations by it) agree byte-for-byte.
// The `d:` prefix is historical, and the persisted outbox is keyed by it.
export function roundKeyForDay(dayNumber: number, lang: string): string {
  return `d:${dayNumber}:${lang}`;
}

// The dayNumber a day-keyed round belongs to, or null for a legacy non-day key. Orders
// day rounds newest-first for the retention cap, and marks legacy rounds for dropping.
function dayNumberOf(key: string): number | null {
  const m = /^d:(\d+):/.exec(key);
  return m ? Number(m[1]) : null;
}

// Retention cap: keep at most this many day-keyed entries (newest by dayNumber). ~800 ≈ a
// year of daily play in two languages with headroom; an outbox is normally empty, so
// transaction clone/read cost stays bounded.
const MAX_DAY_ROUNDS = 800;

// Bound a day-keyed map: with more than MAX_DAY_ROUNDS entries, drop the oldest (lowest
// dayNumber), always keeping `activeKey`. Anything that is not a day key (a legacy round
// left by an older blob) is dropped outright.
function capDayKeyed<T>(entries: Record<string, T>, activeKey: string): Record<string, T> {
  const dayKeys = Object.keys(entries).filter((k) => dayNumberOf(k) !== null);
  const survivors = new Set<string>();
  // Reserve one of the bounded slots for the active round, even when an archive player is
  // reopening the oldest retained day. Adding it after slicing could otherwise make the
  // supposed 800-entry cap hold 801 entries.
  if (dayNumberOf(activeKey) !== null && activeKey in entries) survivors.add(activeKey);
  for (const key of dayKeys.sort((a, b) => dayNumberOf(b)! - dayNumberOf(a)!)) {
    if (survivors.size >= MAX_DAY_ROUNDS) break;
    survivors.add(key);
  }
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (survivors.has(k)) out[k] = v;
  }
  return out;
}

export interface IdentityOwner {
  accountId: string;
  deviceId: string;
}

export interface PersistedState {
  // The proof that lets persisted game state cross a reload. The outbox belongs to the
  // ACCOUNT. A missing/corrupt device key can no longer turn an ownerless blob into a first
  // act for a newly bootstrapped account.
  // `null` is valid only while a deliberate first act has begun a bootstrap that has not
  // answered yet; startup reconciliation checks the pending-token record before keeping it.
  identityOwner: IdentityOwner | null;
  // Unacknowledged sentence guesses, keyed by roundKey (#214). An entry exists only while
  // this device owes the server something: an accepted write removes what it acknowledged,
  // and an emptied entry is dropped, so a device that is caught up persists no rounds at
  // all. Bounded (`capDayKeyed`), for the archive-day case where several outboxes are
  // stranded offline at once.
  outbox: Record<string, RoundOutbox>;
  // Last-played language: seeds the `/` redirect so a return visit lands where you
  // last played (falls back to the browser language, then English).
  lastLang: string | null;
  // The onboarding tutorial (#51) has been completed or skipped. Global, not
  // per-language — the mechanic is the same in both.
  onboarded: boolean;
  // Which #190 board tab is up — a GROUP (the trusted default, #271) or GLOBAL. It belongs to
  // the current VISIT to the leaderboard, not to the player (user feedback 2026-08-20,
  // narrowing the first cut, which made it a standing preference). Two things remount
  // that screen without ending the visit — a page REFRESH and a header LANGUAGE PICK (App
  // keys it on the language) — and both were dropping a player who had chosen GLOBAL back
  // onto the group. So it is PERSISTED, which is the only way to survive the reload; and
  // App RESETS it the moment a non-board route renders, which is what ends the visit.
  // That reset lives in App rather than at each entry point precisely because an entry
  // that forgot it would silently reopen on the old tab forever.
  boardTab: BoardTab;
  // WHICH group the board last showed (#271): the tab the leaderboard reopens on, and the
  // group whose standing the solved screen prints (user-decided 2026-09-07: "the group
  // last opened"). Persisted like the tab, and ACCOUNT-owned — a device that leaves an
  // account may not keep pointing at a group it is no longer in (`reconcileIdentity`).
  // A stale id (left, removed) is simply not among the groups the server lists, and the
  // screen falls back to the first one.
  lastGroupId: string | null;
  // The sentence game's one-time instructions gate has been passed (2026-08-11). The gate
  // exists only to state the rules, so it is shown ONCE ever, globally: the rules are the
  // same in both languages and on every day. *(Amended by the #216 trigger rework,
  // user-decided 2026-08-24: a device with NO account shows the full rules gate again
  // whatever this flag says — its PLAY is what deploys the account. This flag still keeps
  // an account-holding player from ever seeing the rules twice.)*
  sentenceRulesSeen: boolean;
  // The PRE-ACCOUNT identity seed (#216 trigger rework, user-decided 2026-08-24): a
  // publicId-shaped random value the leaderboard strip and the profile editor derive the
  // placeholder name and mark from (`anonName`/`defaultAvatar`) while the device has no
  // account — those surfaces no longer deploy one merely by being opened. Persisted so the
  // placeholder is stable across visits and tabs; a DISPLAY value only, never sent to the
  // server. When the account deploys, the server-assigned id takes over and the derived
  // face changes once — unavoidable, since the server picks the id.
  localSeed: string | null;
}

interface GameState extends PersistedState {
  // Where each round's AUTHORITATIVE state is (#214). NOT persisted, deliberately: the
  // server owns the log, the client holds its last answer for as long as the tab lives,
  // and a new visit asks again rather than replaying a mirror that may be stale.
  roundLoads: Record<string, RoundLoad>;

  // The tutorial currently on screen (transient, NOT persisted): 'first' = the run a
  // newcomer accepted from the invitation, 'replay' = summoned via the header's "?".
  // It lives in the store (not GameRoute state) so it survives a language pick —
  // the route changes under the lesson, and it reopens INTO the tutorial in that
  // language.
  tutorialOpen: 'first' | 'replay' | null;
  openTutorial: (kind: 'first' | 'replay') => void;
  closeTutorial: () => void;

  // Remember the last-played language (drives the `/` redirect). Ignores non-languages.
  setLastLang: (lang: string) => void;

  // Which board tab is up (#190), and the end of a visit to it: the GROUP again.
  setBoardTab: (tab: BoardTab) => void;
  resetBoardTab: () => void;
  // The group the board last showed (#271) — set by the leaderboard on every group tab it
  // opens, and by the solved screen's standing line on its way to the board.
  setLastGroup: (group: string | null) => void;

  // Mark the onboarding tutorial as seen (finish AND skip both count — never re-nag).
  setOnboarded: () => void;

  // The pre-account identity seed. Hydration establishes it transactionally before paint
  // so two fresh tabs cannot show different placeholders; this method is the synchronous
  // accessor/fallback for non-browser tests or unavailable persistence. Never a trigger:
  // generating a local random value contacts no server and creates no account.
  ensureLocalSeed: () => string;

  // Mark the sentence game's one-time instructions gate as passed (its PLAY tap).
  markSentenceRulesSeen: () => void;

  // Reconcile the persisted OUTBOX to `key` playing `puzzle` (#214). An outbox naming a
  // DIFFERENT published revision is DROPPED — its guesses answered a retired question —
  // and any legacy non-day key goes with it; the map is then bounded by the most-recent
  // cap. Called before the round's first render, so no
  // read path ever sees an outbox belonging to another puzzle.
  //
  // It never CREATES one. An outbox exists only while this device owes the server
  // something, so a round with nothing pending — which is every round between an accepted
  // write and the next guess — persists no entry at all.
  ensureOutbox: (key: string, puzzle: string) => void;

  // Append one counted guess to the outbox, CREATING it if this round owes nothing yet.
  // The caller has already deduplicated it against the PLAY LOG (the store holds no rank
  // map and cannot judge identity), and the board has already reacted: this is only the
  // write buffer, and nothing waits on its flush.
  //
  // It carries the `puzzle` because it may be the thing that mints the entry: an accepted
  // write REMOVES an emptied outbox, so most guesses of a round arrive with nothing to
  // append into. Taking the revision from the caller — which is playing it — is what keeps
  // that from either dropping the guess or inventing a version.
  appendOutbox: (key: string, puzzle: string, typed: string) => void;

  // REPLACE the outbox with what is still unacknowledged — the sync engine's own reading of
  // an answer (`game/playLog.ts`). Guarded on `puzzle` so an answer about a retired
  // revision can never resurrect its guesses into the round that replaced it.
  setOutbox: (key: string, puzzle: string, guesses: string[]) => void;

  // The server has closed the round (solved or capped), so every pending guess is refused.
  // This is deliberately distinct from a normal acknowledgement that happens to leave an
  // empty remainder: the latter must preserve a sibling tab's concurrently appended guess.
  discardOutbox: (key: string, puzzle: string) => void;

  // Where a round's authoritative state is. The sync engine is the only writer: 'loading'
  // while its read is out, 'ready' with the server's own state, 'failed' when the read
  // could not be had — which the screen shows rather than starting from a guess. `null`
  // FORGETS a round, which the engine does when it evicts that round's conversation: the
  // flight is what owns the state, and the next mount reads it again.
  setRoundLoad: (key: string, load: RoundLoad | null) => void;
}

export const GAME_PERSIST_VERSION = 19;

// Version upgrades for the persisted blob (exported for the invariant tests).
//   v0 was a single top-level round ({ roundKey, holes, ... }); the shape is now a keyed
//     map, so discard the old state rather than mis-merge it (one-time reset).
//   v1 may still carry the RETIRED keyboard `layout` preference (removed with the AZERTY
//     layout) — picking only the current fields silently drops it. A v19 blob may likewise
//     still carry the retired Word mode's `wordRounds` and `lastMode` (removed 2026-09-16),
//     dropped the same way. v1 also predates the
//     onboarding tutorial (#51): anyone with existing play state has already learned the
//     game, so GRANDFATHER them (rounds or a lastLang -> onboarded) — a veteran must
//     never be surprised by the tutorial.
//   v3 adds the per-language solved-day set (#56): any older blob gets an empty set (NO
//     backfill from rounds — the streak starts fresh, by decision), and the counters are
//     derived from it, never persisted.
//   v4 added `routeSeen` (#129) — the flag that armed the one-time first-solve auto-open. v5
//     RETIRES it with the auto-open itself (#155: the onboarding now ends by tapping a word,
//     so the map no longer introduces itself mid-round). Like the retired keyboard `layout`
//     before it, picking only the current fields silently drops it from any older blob.
//   v8 adds `sentenceRulesSeen` (2026-08-11): the sentence game's one-time instructions
//     gate. Older blobs get false — deliberately NOT grandfathered the way `onboarded`
//     is, because the gate teaches the history tap, which is newer than any existing
//     player's play state; every player sees it exactly once.
//   v19 (#271) renames the trusted tab 'friends' -> 'group' and adds `lastGroupId`; an
//     older blob's tab reads as the default, its group as none.
//   v9 adds `boardTab` (2026-08-20): which #190 board tab is up. Older blobs get
//     'friends', the default the screen already opens on, so nothing changes for anyone
//     already using it. It is persisted only so a REFRESH does not end a visit to the
//     board — App clears it on leaving one — so a stored 'global' is at most one
//     interrupted visit old, never a preference to honour forever.
//   v10 retires `scoreSubmitted` (2026-08-20): a finished round now asks the population
//     until the population HOLDS it, so `scoreRecorded` alone settles a round and the old
//     flag has no reader. It is STRIPPED rather than left as unread cruft (the v1 keyboard
//     `layout` precedent), and stripping is also what HEALS the rounds it stranded — every
//     round a 4xx burned (and, before the 2026-08-16 correction, every 5xx too) carried the
//     flag with no recorded score, and now submits again on the next visit to its solved
//     screen.
//   v12 retires `scoreRecorded` from the round maps (#203): there is no client-claimed
//     score left to reconcile — the server derives it from the guess log and records the
//     row itself — so what a finished round persists is `recorded`, a plain "the server
//     holds this round's solve", written from the round answers rather than from a score
//     POST. STRIPPED, not translated (the v10 precedent, and the standing no-back-compat
//     rule): a sentence round appended to AFTER this ships re-learns the fact from the
//     answer that says `solved`.
//     **A round already SOLVED before this ships does NOT recover, and never will**
//     (corrected on review): its stored row was written by a pre-#203 append, so it carries
//     no `solved` attribute, its mount READ answers `solved: false`, and with nothing left
//     pending no append ever fires to derive one — so `recorded` is never set and its solved
//     screen silently loses the standing line for good. Backfilling it server-side would be
//     the compatibility layer this repo does not keep, and the cost is bounded to
//     pre-launch rounds at most a day old against an archive that is wiped before launch.
//   v13 DROPS every sentence round stored before the published revision existed (#203).
//     `ensureRound` briefly ADOPTED one whose holes still matched, on the reasoning that a
//     deploy must not throw away play in progress — which is a compatibility layer, and the
//     repo does not keep those (root AGENTS.md: remove obsolete paths, never accommodate
//     them). It is also not safe on its own terms: a pre-stamp round cannot say WHICH
//     version it was played against, and since rank 0 is a GROUP, a correction can move the
//     aliases that decide `solved` without touching a single hole — so the holes matching
//     proves nothing about the maps. Dropped at the migration rather than lazily on mount,
//     so every round that survives carries a revision by construction and no read path needs
//     a branch for one that does not. Solved days and the streak are untouched; the cost is
//     device-local sentence play at most a day old, against an archive wiped before launch.
//   v14 DROPS the sentence `rounds` map OUTRIGHT (#214), and with it every round-shaped
//     migration this list has accumulated. Local storage is an OUTBOX now: the server owns a
//     round's log from its first guess, so a persisted holes/progress/count/flags mirror was
//     a second answer to questions the server already answers — which is what made every
//     visit a reconciliation. There is nothing to translate: a stored round's UNSENT guesses
//     were never distinguishable from its acknowledged ones (`tried` is one merged list), so
//     re-seeding an outbox from it would re-send guesses the server already holds, burn the
//     cap on duplicates and — near the cap — cost an honest player their leaderboard entry.
//     The mount READ recovers what the server has, which for anything that ever flushed is
//     everything; the cost is guesses stranded on a device that has been offline since its
//     last flush, at most one round's worth. Every preference is untouched (the archive and
//     the streak get their server-backed source in #211, which ships with this — see v15).
//   v15 DROPS `solvedDays` (#211), the last device-local half of a player's history. The
//     per-language solved-day collection lives on the private player row now, credited by
//     the append that CONFIRMS a solve and read back through the private history path, so a
//     persisted copy would be the same second authority v14 removed for rounds — and one
//     that cannot follow a player to a second device, which is the gap that made this a
//     release blocker. STRIPPED rather than migrated: there is nowhere to migrate it TO (the
//     collection is server-side and rebuilt from the authoritative round rows), and the
//     standing no-back-compat rule says an obsolete path is removed, not accommodated. The
//     cost is that a device whose rounds were never synced loses its streak; every round
//     that ever flushed is on the server, and #214 already made that the only kind there is.
//   v16 DROPS the OUTBOX (#216), because it belongs to an identity this device no longer
//     has. Until #216 the identity was a shared secret (#187); it is now a
//     device token resolving to a SERVER-assigned account, and there is no mapping between
//     the two — the epic wipes the DB before launch and takes no migration. Left in place,
//     it is worse than stale: the tokenless branch pumps a surviving outbox on the very
//     first page load, which bootstraps a BRAND-NEW account and then appends the retired
//     identity's guesses to it. Every preference survives, as at v14 and v15.
//   v17 BINDS the outbox to its #216 owner. A v16 blob can carry state but cannot prove
//     which device/account produced it, so it is dropped under the same no-back-compat rule
//     as v16's retired-secret state. New ownerless state survives only while the device key
//     carries the pending token minted by the act that created it; startup reconciliation
//     drops it when the key is missing or corrupt instead of bootstrapping a stranger.
//   v18 changes the STORAGE boundary, not this content shape: the state lives behind the
//     transactional IndexedDB record (gamePersistence.ts). The retired v17 localStorage
//     blob is NOT read — the standing no-back-compat rule (the v14 precedent): an
//     empty database starts from the initial state, and the one-time cost is pre-launch
//     preferences on existing devices.
function storedRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseOutbox(value: unknown): Record<string, RoundOutbox> {
  const outbox: Record<string, RoundOutbox> = {};
  for (const [key, candidate] of Object.entries(storedRecord(value))) {
    const entry = storedRecord(candidate);
    if (
      typeof entry.puzzle === 'string' &&
      Array.isArray(entry.guesses) &&
      entry.guesses.every((guess) => typeof guess === 'string')
    ) {
      outbox[key] = { puzzle: entry.puzzle, guesses: entry.guesses };
    }
  }
  return outbox;
}

export function migratePersisted(persisted: unknown, version: number): PersistedState {
  if (version < 1) {
    return {
      identityOwner: null,
      outbox: {},
      lastLang: null,
      onboarded: false,
      boardTab: 'group',
      lastGroupId: null,
      sentenceRulesSeen: false,
      localSeed: null,
    };
  }
  const p = (
    typeof persisted === 'object' && persisted !== null ? persisted : {}
  ) as Partial<PersistedState> & { rounds?: Record<string, unknown> };
  const legacyRounds = storedRecord(p.rounds);
  const lastLang = typeof p.lastLang === 'string' && isLang(p.lastLang) ? p.lastLang : null;
  // Grandfathering asks whether this person has PLAYED before, which the RAW blob answers —
  // including through the `rounds` map v14 drops, since a veteran whose only signal is their
  // play history must not be handed the tutorial back.
  const onboarded =
    typeof p.onboarded === 'boolean'
      ? p.onboarded
      : Object.keys(legacyRounds).length > 0 || lastLang != null;
  const sentenceRulesSeen = p.sentenceRulesSeen === true;
  // The pre-account seed is display-only, so a malformed one simply re-mints on next need.
  const localSeed =
    typeof p.localSeed === 'string' && PUBLIC_ID_PATTERN.test(p.localSeed) ? p.localSeed : null;
  const boardTab = p.boardTab === 'global' ? 'global' : 'group';
  const lastGroupId =
    typeof p.lastGroupId === 'string' && GROUP_ID_PATTERN.test(p.lastGroupId) ? p.lastGroupId : null;
  const parsedOwner = version < 17 ? null : parseIdentityOwner(p.identityOwner);
  // `undefined` means a current-version blob claimed an owner but did not carry a valid
  // one. Fail closed: the outbox may not survive malformed ownership metadata.
  const stateHasOwnerContract = version >= 17 && parsedOwner !== undefined;
  // The outbox arrives with v14 and holds only UNACKNOWLEDGED guesses, which no older blob
  // can distinguish inside its merged `tried` list (see the v14 note) — so an older one
  // starts empty rather than re-sending a log the server already holds. v16 raised that
  // floor for the retired secret; v17 raises it again for ownerless device-token state.
  const outbox = stateHasOwnerContract ? parseOutbox(p.outbox) : {};
  return {
    identityOwner: parsedOwner ?? null,
    outbox,
    lastLang,
    onboarded,
    boardTab,
    lastGroupId,
    sentenceRulesSeen,
    localSeed,
  };
}

function parseIdentityOwner(value: unknown): IdentityOwner | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === null) return undefined;
  const { accountId, deviceId } = value as Record<string, unknown>;
  if (
    typeof accountId !== 'string' ||
    !PUBLIC_ID_PATTERN.test(accountId) ||
    typeof deviceId !== 'string' ||
    !PUBLIC_ID_PATTERN.test(deviceId)
  ) {
    return undefined;
  }
  return { accountId, deviceId };
}

export function initialPersistedState(): PersistedState {
  return {
    identityOwner: null,
    outbox: {},
    lastLang: null,
    onboarded: false,
    boardTab: 'group',
    lastGroupId: null,
    sentenceRulesSeen: false,
    localSeed: null,
  };
}

type OwnedGameMutation = { expectedOwner: IdentityOwner | null };

export type GameMutation =
  | { type: 'setLastLang'; lang: string }
  | { type: 'setBoardTab'; tab: BoardTab }
  | { type: 'setLastGroup'; group: string | null }
  | { type: 'setOnboarded' }
  | { type: 'setSentenceRulesSeen' }
  | { type: 'ensureLocalSeed'; seed: string }
  | ({ type: 'ensureOutbox'; key: string; puzzle: string } & OwnedGameMutation)
  | ({ type: 'appendOutbox'; key: string; puzzle: string; typed: string } & OwnedGameMutation)
  | ({
      type: 'settleOutbox';
      key: string;
      puzzle: string;
      before: string[];
      after: string[];
    } & OwnedGameMutation)
  | ({ type: 'discardOutbox'; key: string; puzzle: string } & OwnedGameMutation)
  | {
      type: 'reconcileIdentity';
      expectedOwner: IdentityOwner | null;
      identity: IdentityOwner | null;
      pendingBootstrap: boolean;
    };

export interface GameMutationResult {
  state: PersistedState;
  changed: boolean;
  landed?: boolean;
}

function sameOwner(a: IdentityOwner | null, b: IdentityOwner | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.accountId === b.accountId && a.deviceId === b.deviceId)
  );
}

function changed(state: PersistedState, next: PersistedState, landed?: boolean): GameMutationResult {
  return { state: next, changed: next !== state, ...(landed === undefined ? {} : { landed }) };
}

function removeAcknowledged(current: string[], before: string[], after: string[]): string[] {
  // `after` is a stable-order subset of `before`. Count only what that answer removed and
  // apply those removals to the latest committed list; guesses a sibling appended after the
  // request snapshot are therefore preserved. Equal duplicate strings are interchangeable:
  // removing either occurrence leaves the same debt and the same ordering among survivors.
  const removed = new Map<string, number>();
  for (const guess of before) removed.set(guess, (removed.get(guess) ?? 0) + 1);
  for (const guess of after) {
    const count = removed.get(guess) ?? 0;
    if (count <= 1) removed.delete(guess);
    else removed.set(guess, count - 1);
  }
  if (removed.size === 0) return current;
  let didRemove = false;
  const next = current.filter((guess) => {
    const count = removed.get(guess) ?? 0;
    if (count === 0) return true;
    didRemove = true;
    if (count === 1) removed.delete(guess);
    else removed.set(guess, count - 1);
    return false;
  });
  return didRemove ? next : current;
}

// One pure interpreter is used twice: immediately against the tab's cache (the synchronous
// UI contract), then inside one IndexedDB readwrite transaction against the latest committed
// value (the durability/cross-tab contract). The mutation states intent; no stale snapshot is
// ever asked to infer which field or map key changed.
export function applyGameMutation(
  state: PersistedState,
  mutation: GameMutation,
): GameMutationResult {
  if ('expectedOwner' in mutation && mutation.type !== 'reconcileIdentity') {
    if (!sameOwner(state.identityOwner, mutation.expectedOwner)) return changed(state, state, false);
  }

  switch (mutation.type) {
    case 'setLastLang':
      return state.lastLang === mutation.lang
        ? changed(state, state)
        : changed(state, { ...state, lastLang: mutation.lang });
    case 'setBoardTab':
      return state.boardTab === mutation.tab
        ? changed(state, state)
        : changed(state, { ...state, boardTab: mutation.tab });
    case 'setLastGroup':
      return state.lastGroupId === mutation.group
        ? changed(state, state)
        : changed(state, { ...state, lastGroupId: mutation.group });
    case 'setOnboarded':
      return state.onboarded ? changed(state, state) : changed(state, { ...state, onboarded: true });
    case 'setSentenceRulesSeen':
      return state.sentenceRulesSeen
        ? changed(state, state)
        : changed(state, { ...state, sentenceRulesSeen: true });
    case 'ensureLocalSeed':
      return state.localSeed !== null
        ? changed(state, state)
        : changed(state, { ...state, localSeed: mutation.seed });
    case 'ensureOutbox': {
      const kept = { ...state.outbox };
      const existing = kept[mutation.key];
      if (existing && existing.puzzle !== mutation.puzzle) delete kept[mutation.key];
      const outbox = capDayKeyed(kept, mutation.key);
      const same =
        Object.keys(outbox).length === Object.keys(state.outbox).length &&
        Object.entries(outbox).every(([key, value]) => state.outbox[key] === value);
      return same ? changed(state, state) : changed(state, { ...state, outbox });
    }
    case 'appendOutbox': {
      const existing = state.outbox[mutation.key];
      const guesses = existing?.puzzle === mutation.puzzle ? existing.guesses : [];
      const outbox = capDayKeyed(
        {
          ...state.outbox,
          [mutation.key]: { puzzle: mutation.puzzle, guesses: [...guesses, mutation.typed] },
        },
        mutation.key,
      );
      return changed(state, { ...state, outbox });
    }
    case 'settleOutbox': {
      const existing = state.outbox[mutation.key];
      if (!existing || existing.puzzle !== mutation.puzzle) return changed(state, state);
      const guesses = removeAcknowledged(existing.guesses, mutation.before, mutation.after);
      if (guesses === existing.guesses) return changed(state, state);
      if (guesses.length === 0) {
        const { [mutation.key]: _settled, ...outbox } = state.outbox;
        return changed(state, { ...state, outbox });
      }
      return changed(state, {
        ...state,
        outbox: { ...state.outbox, [mutation.key]: { ...existing, guesses } },
      });
    }
    case 'discardOutbox': {
      const existing = state.outbox[mutation.key];
      if (!existing || existing.puzzle !== mutation.puzzle) return changed(state, state);
      const { [mutation.key]: _discarded, ...outbox } = state.outbox;
      return changed(state, { ...state, outbox });
    }
    case 'reconcileIdentity': {
      // A late transition from A must not clear a state already rebound to B by a sibling.
      // If the target is already committed, the mutation is simply idempotent.
      if (!sameOwner(state.identityOwner, mutation.expectedOwner)) {
        return changed(state, state);
      }
      if (mutation.identity === null) {
        if (mutation.pendingBootstrap && state.identityOwner === null) return changed(state, state);
        if (state.identityOwner === null && Object.keys(state.outbox).length === 0) {
          return changed(state, state);
        }
        return changed(state, {
          ...state,
          identityOwner: null,
          outbox: {},
          lastGroupId: null,
        });
      }
      if (state.identityOwner === null) {
        return changed(state, { ...state, identityOwner: mutation.identity });
      }
      const accountChanged = state.identityOwner.accountId !== mutation.identity.accountId;
      const deviceChanged = state.identityOwner.deviceId !== mutation.identity.deviceId;
      if (!accountChanged && !deviceChanged) return changed(state, state);
      return changed(state, {
        ...state,
        identityOwner: mutation.identity,
        ...(accountChanged ? { outbox: {}, lastGroupId: null } : {}),
      });
    }
  }
}

export function persistedStateOf(state: GameState): PersistedState {
  return {
    identityOwner: state.identityOwner,
    outbox: state.outbox,
    lastLang: state.lastLang,
    onboarded: state.onboarded,
    boardTab: state.boardTab,
    lastGroupId: state.lastGroupId,
    sentenceRulesSeen: state.sentenceRulesSeen,
    localSeed: state.localSeed,
  };
}

export const useGameStore = create<GameState>((set, get) => {
  const commit = (mutation: GameMutation): GameMutationResult => {
    const result = applyGameMutation(persistedStateOf(get()), mutation);
    if (result.changed) set(result.state);
    enqueueGameMutation(mutation);
    return result;
  };

  return {
    ...initialPersistedState(),
    roundLoads: {},
    tutorialOpen: null,

    openTutorial: (kind) => set({ tutorialOpen: kind }),
    closeTutorial: () => set({ tutorialOpen: null }),

    // Do not short-circuit persisted intent merely because this tab's cache already holds
    // the value: a sibling may have committed a different one while its notification is
    // still queued. The transaction is where equality is authoritative.
    setLastLang: (lang) => {
      if (!isLang(lang)) return;
      commit({ type: 'setLastLang', lang });
    },
    setBoardTab: (tab) => {
      commit({ type: 'setBoardTab', tab });
    },
    resetBoardTab: () => {
      commit({ type: 'setBoardTab', tab: 'group' });
    },
    setLastGroup: (group) => {
      commit({ type: 'setLastGroup', group });
    },
    setOnboarded: () => {
      commit({ type: 'setOnboarded' });
    },
    markSentenceRulesSeen: () => {
      commit({ type: 'setSentenceRulesSeen' });
    },
    ensureLocalSeed: () => {
      const held = get().localSeed;
      if (held !== null) return held;
      const seed = generatePublicId();
      return commit({ type: 'ensureLocalSeed', seed }).state.localSeed ?? seed;
    },

    ensureOutbox: (key, puzzle) => {
      commit({ type: 'ensureOutbox', key, puzzle, expectedOwner: get().identityOwner });
    },
    appendOutbox: (key, puzzle, typed) => {
      commit({ type: 'appendOutbox', key, puzzle, typed, expectedOwner: get().identityOwner });
    },
    setOutbox: (key, puzzle, guesses) => {
      const existing = get().outbox[key];
      if (!existing || existing.puzzle !== puzzle) return;
      commit({
        type: 'settleOutbox',
        key,
        puzzle,
        before: existing.guesses,
        after: guesses,
        expectedOwner: get().identityOwner,
      });
    },
    discardOutbox: (key, puzzle) => {
      commit({ type: 'discardOutbox', key, puzzle, expectedOwner: get().identityOwner });
    },

    setRoundLoad: (key, load) =>
      set((state) => {
        if (load === null) {
          if (!(key in state.roundLoads)) return {};
          const { [key]: _gone, ...roundLoads } = state.roundLoads;
          return { roundLoads };
        }
        return { roundLoads: { ...state.roundLoads, [key]: load } };
      }),

  };
});

const GAME_SYNC_CHANNEL = 'whippin-game-sync';
const GAME_SYNC_SIGNAL = 'whippin-game-sync-signal';

let gameDatabase: GameStateDatabase<PersistedState> | null = null;
let persistenceReady = false;
let writeTail: Promise<void> = Promise.resolve();
let queuedWrites = 0;
let mutationGeneration = 0;
let refreshWanted = false;
let refreshFlight: Promise<void> | null = null;
let syncChannel: BroadcastChannel | null = null;
const syncSource = generatePublicId();
let syncSequence = 0;

function normalizedEnvelope(
  stored: StoredGameState<PersistedState> | null,
): StoredGameState<PersistedState> {
  const source = stored;
  if (!source) return { version: GAME_PERSIST_VERSION, state: initialPersistedState() };
  const sourceVersion =
    typeof source.version === 'number' &&
    Number.isInteger(source.version) &&
    source.version >= 0
      ? source.version
      : 0;
  if (sourceVersion > GAME_PERSIST_VERSION) {
    throw new Error(`game state version ${sourceVersion} is newer than this build`);
  }
  return {
    version: GAME_PERSIST_VERSION,
    state: migratePersisted(source.state, sourceVersion),
  };
}

// Reuse the tab's CURRENT object identities wherever the committed value is structurally
// equal. Every committed envelope is rebuilt from the stored record inside its
// transaction, so without this each applied commit would hand the screens a fresh
// `outbox` object about once a second while a player types — and every
// derivation downstream (the play log, the board replay, the run's trajectory) would
// recompute for values that did not change (the roundSync `sameServer` rule).
function stableEntries<T>(
  next: Record<string, T>,
  current: Record<string, T>,
  same: (a: T, b: T) => boolean,
): Record<string, T> {
  const keys = Object.keys(next);
  let reusedAll = keys.length === Object.keys(current).length;
  const out: Record<string, T> = {};
  for (const key of keys) {
    const held = current[key];
    if (held !== undefined && same(held, next[key])) {
      out[key] = held;
    } else {
      out[key] = next[key];
      reusedAll = false;
    }
  }
  return reusedAll ? current : out;
}

const sameLog = (a: readonly string[], b: readonly string[]) =>
  a === b || (a.length === b.length && a.every((guess, index) => guess === b[index]));

const sameOutboxEntry = (a: RoundOutbox, b: RoundOutbox) =>
  a.puzzle === b.puzzle && sameLog(a.guesses, b.guesses);

function applyCommittedState(state: PersistedState, forceOwner = false): void {
  const current = useGameStore.getState();
  const ownerMatches = sameOwner(current.identityOwner, state.identityOwner);
  const adoptOwned = forceOwner || ownerMatches;
  useGameStore.setState({
    lastLang: state.lastLang,
    boardTab: state.boardTab,
    onboarded: state.onboarded,
    sentenceRulesSeen: state.sentenceRulesSeen,
    localSeed: state.localSeed,
    ...(adoptOwned
      ? {
          identityOwner: ownerMatches ? current.identityOwner : state.identityOwner,
          outbox: stableEntries(state.outbox, current.outbox, sameOutboxEntry),
        }
      : {}),
  });
}

function announceCommittedChange(): void {
  if (syncChannel !== null) {
    try {
      syncChannel.postMessage(null);
      return;
    } catch {
      // A channel can close between a queued commit and this notification (notably under
      // HMR). The commit already succeeded; fall back to the storage signal rather than
      // misreporting a notification failure as a persistence failure.
    }
  }
  if (typeof window === 'undefined') return;
  try {
    syncSequence += 1;
    // Web Storage emits no event when the value is unchanged. Include this tab's random
    // source as well as its sequence so two fallback-only tabs committing in the same
    // millisecond cannot accidentally suppress the second invalidation.
    window.localStorage.setItem(GAME_SYNC_SIGNAL, `${syncSource}:${syncSequence}`);
  } catch {
    // IndexedDB remains authoritative. A tab whose fallback signal cannot be written still
    // reads the latest state before its own next mutation; only its passive view is stale.
  }
}

function enqueueGameMutation(mutation: GameMutation): void {
  if (!persistenceReady || gameDatabase === null) return;
  mutationGeneration += 1;
  const generation = mutationGeneration;
  queuedWrites += 1;
  const database = gameDatabase;
  const task = writeTail.then(async () => {
    // One permanent failure switches the session to the same memory-only mode used when
    // IndexedDB cannot open at startup. Do not commit a later suffix while an earlier
    // mutation exists only in memory: preserving order is more important than a partial
    // persisted history that would roll the UI back on refresh.
    if (!persistenceReady || gameDatabase !== database) return;
    let committed: StoredGameState<PersistedState> | null = null;
    let didChange = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        committed = await database.update((stored) => {
          const current = normalizedEnvelope(stored);
          const result = applyGameMutation(current.state, mutation);
          didChange = result.changed;
          return result.changed ? { version: GAME_PERSIST_VERSION, state: result.state } : current;
        });
        lastError = undefined;
        break;
      } catch (error) {
        // `tx.done` rejects only when the readwrite transaction aborted, so retrying the
        // semantic mutation cannot duplicate a commit. A permanent failure falls through
        // after three attempts and, importantly, does not poison the following writes.
        lastError = error;
      }
    }
    if (lastError !== undefined) throw lastError;
    // The transaction just computed the exact committed envelope — the latest committed
    // state (sibling tabs' writes included, since it read them inside the transaction)
    // plus this mutation — so apply IT rather than reading the whole record back and
    // re-running the migrations per guess, which is what the old per-write refresh cost.
    // Only while this is still the NEWEST enqueued mutation, though: applying an older
    // envelope over in-memory state that already holds later mutations would make later
    // guesses vanish from the screen until their own commits land. A skipped apply is
    // safe — a later task (or a sibling's announced invalidation) carries newer truth.
    if (committed !== null && mutationGeneration === generation) {
      applyCommittedState(committed.state);
    }
    if (didChange) announceCommittedChange();
  });
  writeTail = task
    .catch((error: unknown) => {
      // The cache stays usable and the engine still talks to the server. Fall back as one
      // unit: later mutations remain in memory too, so a failed prefix cannot be skipped
      // and then erased by refreshing a partially committed suffix.
      console.error('Failed to persist game state', error);
      if (gameDatabase === database) {
        gameDatabase = null;
        persistenceReady = false;
        void database.close().catch(() => {});
      }
    })
    .finally(() => {
      queuedWrites -= 1;
      // Serve a cross-tab invalidation that arrived WHILE this tab's writes were queued:
      // `refreshCommittedState` parks itself behind the queue (`refreshWanted`), and the
      // drain is what lets it run. This tab's OWN commit no longer schedules one — the
      // transaction's returned envelope was applied directly above.
      if (persistenceReady && refreshWanted && queuedWrites === 0) void refreshCommittedState();
    });
}

async function refreshCommittedState(): Promise<void> {
  if (!persistenceReady || gameDatabase === null) return;
  refreshWanted = true;
  if (queuedWrites > 0 || refreshFlight !== null) return refreshFlight ?? undefined;
  const database = gameDatabase;
  refreshFlight = (async () => {
    while (refreshWanted && queuedWrites === 0) {
      refreshWanted = false;
      const generation = mutationGeneration;
      const stored = await database.read();
      if (queuedWrites > 0 || generation !== mutationGeneration) {
        refreshWanted = true;
        break;
      }
      if (stored !== null) applyCommittedState(normalizedEnvelope(stored).state);
    }
  })()
    .catch((error: unknown) => {
      console.error('Failed to refresh game state', error);
    })
    .finally(() => {
      refreshFlight = null;
      if (refreshWanted && queuedWrites === 0) void refreshCommittedState();
    });
  return refreshFlight;
}

// Hydrate before React mounts: the first IndexedDB transaction wins across simultaneously
// opening tabs and establishes the placeholder seed in that same atomic state before
// either tab paints. (The retired v17 localStorage blob is NOT imported — see the v18
// migration note.)
export async function hydrateGameStore(): Promise<void> {
  if (persistenceReady) return;
  if (typeof indexedDB === 'undefined') {
    const fallback = initialPersistedState();
    const seeded = applyGameMutation(fallback, {
      type: 'ensureLocalSeed',
      seed: generatePublicId(),
    }).state;
    applyCommittedState(seeded, true);
    return;
  }

  let database: GameStateDatabase<PersistedState> | null = null;
  try {
    database = new GameStateDatabase<PersistedState>();
    const seed = generatePublicId();
    const stored = await database.update((current) => {
      const normalized = normalizedEnvelope(current);
      const seeded = applyGameMutation(normalized.state, { type: 'ensureLocalSeed', seed }).state;
      return { version: GAME_PERSIST_VERSION, state: seeded };
    });
    gameDatabase = database;
    persistenceReady = true;
    applyCommittedState(stored.state, true);
  } catch (error) {
    if (database !== null) {
      try {
        await database.close();
      } catch {
        // Opening itself may be what failed; there is then no connection to close.
      }
    }
    console.error('Failed to initialize game persistence', error);
    const fallback = initialPersistedState();
    const seeded = applyGameMutation(fallback, {
      type: 'ensureLocalSeed',
      seed: generatePublicId(),
    }).state;
    applyCommittedState(seeded, true);
  }
}

export async function flushGameStorePersistence(): Promise<void> {
  while (queuedWrites > 0) await writeTail;
  await refreshCommittedState();
}

// IndexedDB supplies atomic writes; this channel is only cache invalidation. A notification
// may be delayed, duplicated or missed without endangering persistence: every mutation reads
// the latest committed state again inside its transaction.
export function installGameStoreSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  const storageListener = (event: StorageEvent) => {
    if (event.key === GAME_SYNC_SIGNAL || event.key === null) void refreshCommittedState();
  };
  window.addEventListener('storage', storageListener);

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(GAME_SYNC_CHANNEL);
      channel.addEventListener('message', refreshCommittedState);
      syncChannel = channel;
    } catch {
      // Some restricted contexts expose the constructor but reject opening a channel.
      // The storage-event signal remains available, and correctness needs neither one.
      channel = null;
    }
  }
  return () => {
    window.removeEventListener('storage', storageListener);
    if (channel !== null) {
      channel.removeEventListener('message', refreshCommittedState);
      channel.close();
      if (syncChannel === channel) syncChannel = null;
    }
  };
}

// Bind the persisted outbox to the identity that may send it. This runs once after the
// device key is loaded and again on every live identity transition. Preferences are never
// identity-owned and therefore never appear in these patches.
export function reconcileGameStateIdentity(
  identity: IdentityOwner | null,
  pendingBootstrap = false,
): void {
  const state = useGameStore.getState();
  const owner = state.identityOwner;
  // Pick the two public ids explicitly: callers pass DeviceIdentity structurally, and
  // spreading it would copy the raw authentication token into the game-state database.
  const nextOwner: IdentityOwner | null =
    identity === null ? null : { accountId: identity.accountId, deviceId: identity.deviceId };
  const mutation: GameMutation = {
    type: 'reconcileIdentity',
    expectedOwner: owner,
    identity: nextOwner,
    pendingBootstrap,
  };
  const result = applyGameMutation(persistedStateOf(state), mutation);

  const accountChanged =
    owner !== null && (nextOwner === null || owner.accountId !== nextOwner.accountId);
  const clearOwnerless = nextOwner === null && !(pendingBootstrap && owner === null);
  useGameStore.setState({
    ...result.state,
    ...(accountChanged || clearOwnerless ? { roundLoads: {} } : {}),
  });
  enqueueGameMutation(mutation);
}
