import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RuntimeHole } from '@whippin/shared';
import { isLang, type Mode } from '../langs';
import { CLAIM_ZONE, runMs } from '../game/wordGame';

// Which crowd the #190 leaderboard is showing: the friends graph (the trusted default)
// or the global top 50. It lives here rather than in the screen because the screen
// remounts under it without the visit ending — see `boardTab` below.
export type BoardTab = 'friends' | 'global';

// A sentence round is identified by its `roundKey` = (server day, language, mode).
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
}

// Where a round's authoritative state is, for the ONE screen that has to wait on it. The
// game is deliberately network-dependent since #214: it may not become interactive from a
// guessed local mirror, so a failed read is a visible state rather than permission to
// start. Word mode keeps its live clock/outbox in `wordRounds` and, once submitted, reads
// the authoritative recorded log from the ready payload here.
export type RoundLoad =
  | { status: 'loading'; puzzle: string }
  | { status: 'failed'; puzzle: string }
  | { status: 'ready'; puzzle: string; server: RoundServer };

// A round key is only (day, language, mode), so a corrected puzzle can reuse it while a
// passive effect has not yet registered the replacement with the sync engine. Never hand
// that first render the retired puzzle's cached READY state: until THIS identity settles,
// its honest state is loading.
export function roundLoadFor(load: RoundLoad | undefined, puzzle: string): RoundLoad {
  return load?.puzzle === puzzle ? load : { status: 'loading', puzzle };
}

// The server state a round with no stored record starts from — a 404 is "nothing yet",
// which is an answer, not a failure.
export const EMPTY_ROUND_SERVER: RoundServer = { guesses: [], solved: false, solvedByAppend: false };

// The canonical round key: (server day, language, MODE — #156: the two dailies would
// otherwise collide on one key). Kept here so the game screens (which build it) and the
// selector/archive (which look it up per language) agree byte-for-byte. Sentence rounds
// keep their historical `d:` prefix; Word mode rounds live under `w:` (in their own map,
// `wordRounds` — the two shapes differ).
export function roundKeyForDay(dayNumber: number, lang: string, mode: Mode = 'sentence'): string {
  return `${mode === 'word' ? 'w' : 'd'}:${dayNumber}:${lang}`;
}

// The dayNumber a day-keyed round belongs to, or null for a legacy non-day key. Orders
// day rounds newest-first for the retention cap, and marks legacy rounds for dropping.
// Both prefixes parse — the sentence and word maps are separate, but they share this
// helper for their caps.
function dayNumberOf(key: string): number | null {
  const m = /^[dw]:(\d+):/.exec(key);
  return m ? Number(m[1]) : null;
}

// Retention cap: keep at most this many day-keyed entries (newest by dayNumber). ~800 ≈ a
// year of daily play in two languages with headroom; word rounds are small (a log + a
// clock) and an outbox is normally empty, so the maps stay well under localStorage limits.
const MAX_DAY_ROUNDS = 800;

// Bound a day-keyed map: with more than MAX_DAY_ROUNDS entries, drop the oldest (lowest
// dayNumber), always keeping `activeKey`. Anything that is not a day key (a legacy round
// left by an older blob) is dropped outright. Written once for both maps — they hold
// different shapes but the same retention story, and two copies of an eviction rule are
// two chances to evict differently.
function capDayKeyed<T>(entries: Record<string, T>, activeKey: string): Record<string, T> {
  const dayKeys = Object.keys(entries).filter((k) => dayNumberOf(k) !== null);
  const survivors = new Set(
    dayKeys.length <= MAX_DAY_ROUNDS
      ? dayKeys
      : dayKeys.sort((a, b) => dayNumberOf(b)! - dayNumberOf(a)!).slice(0, MAX_DAY_ROUNDS),
  );
  survivors.add(activeKey);
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (survivors.has(k)) out[k] = v;
  }
  return out;
}

// Cap for each language's solved-day set (#56), same spirit as MAX_DAY_ROUNDS. The array
// is kept sorted ascending, so the newest solves are at the tail.
const MAX_SOLVED_DAYS = 800;

// Bound one language's solved-day array to its most recent MAX_SOLVED_DAYS entries.
function capSolvedDays(days: number[]): number[] {
  return days.length > MAX_SOLVED_DAYS ? days.slice(-MAX_SOLVED_DAYS) : days;
}

// Bound every language's solved-day array (used by partialize so the persisted blob is
// capped even if a set somehow grew past the limit outside recordSolve).
function capAllSolvedDays(solvedDays: Record<string, number[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [lang, days] of Object.entries(solvedDays)) out[lang] = capSolvedDays(days);
  return out;
}

// One Word mode round (#156, retimed by #163, server-anchored by #202). While a run is
// live, `tried` is its OUTBOX — the counted guesses this device will submit (folded, in
// order; free guesses never enter it), from which the whole run replays
// (game/wordGame.ts replayWordRun) — and `startedAt` is the second source of truth: when
// the run began. A successful submission clears that acknowledged log; the authoritative
// recorded run then lives only in the transient `roundLoads` server snapshot above.
//
// Since #202 that instant is the SERVER's, translated into this device's clock: the sync
// engine reads `startedAt` and the server's own `now` off the round-start answer and
// anchors `Date.now() - (now - startedAt)`. It holds an ELAPSED SPAN rather than an
// instant, so a device whose clock is minutes off still runs a 60-second run — and the
// request's own travel time lands INSIDE the run, which is what keeps an honest submission
// clear of the server's end-of-run wait check.
//
// While the run is unacknowledged, `deadline` is DERIVED from those two (startedAt + runMs
// of the log's claimed bonuses) and recomputed on every write, so the clock cannot drift
// away from the guesses that bought it. Once the server acknowledges the run, the outbox
// clears and any still-live deadline clamps to now, then freezes. It is nevertheless
// PERSISTED, because it is the ONE thing the status surfaces need and the one thing they
// cannot compute: the archive
// and the choosers badge a day without loading its rank map, so they cannot replay the log
// to price it.
//
// There is NO `ended` field. Whether a run is over is `now > deadline`, wall-clock and
// always current — a stored boolean would be a second answer to the same question, stale
// the moment the tab is closed (which is exactly the case the no-pause rule is about).
// `claimed` stays a cached derived value for those same status surfaces, like
// RoundProgress.progress; never the source of truth. Once acknowledged it records the
// authoritative run's count while the transient server log supplies the post-mortem.
// `word` is the day's word slug: a republished different word under the same (day, lang)
// key resets the round instead of replaying a stale log against the new map.
export interface WordRoundProgress {
  word: string;
  // null until the SERVER has stamped this round's start (#202): a fetched-but-unplayed
  // day sits at the rules gate, and the clock has not begun. PLAY asks the server and the
  // visible clock starts when the answer lands — which is also what makes the daily
  // one-shot across devices, since the start the second device resumes is the first one.
  startedAt: number | null;
  deadline: number | null;
  tried: string[];
  claimed: number;
  // The server has ACKNOWLEDGED this round's end-of-run log (#202). Only an optimization:
  // the submission is first-write-wins and safe to repeat, so an unacknowledged round
  // simply asks again on its next visit. Without it, a run that claimed NOTHING would
  // re-POST on every mount forever, since an empty stored log reads exactly like an
  // unsubmitted one.
  submitted?: boolean;
}

// What a REPLAY of a word round's log makes of it — the two numbers the store needs to
// keep the round's cached half honest. `recordWordGuess` takes the replay rather than
// finished values so the cache can never describe a different log than the one it is
// stored beside: handed values are derived from whatever `tried` the caller last
// rendered, which two submissions batched into one tick would make stale — the second
// would overwrite the first's count with a replay that never saw it. The persisted
// deadline may also describe an older rank map after a same-word republish, and only a
// replay against the CURRENT map can repair it. The store owns the log, so the store
// decides what it means; the callback carries the rank map it must not know.
interface WordRunCache {
  claimed: number;
  bonus: number; // seconds the claims bought, summed (game/wordGame.ts replayWordRun)
}

interface PersistedState {
  // Unacknowledged sentence guesses, keyed by roundKey (#214). An entry exists only while
  // this device owes the server something: an accepted write removes what it acknowledged,
  // and an emptied entry is dropped, so a device that is caught up persists no rounds at
  // all. Bounded like the word map, for the archive-day case where several outboxes are
  // stranded offline at once.
  outbox: Record<string, RoundOutbox>;
  // Word mode rounds (#156), keyed by roundKeyForDay(day, lang, 'word'). Their own map
  // because the shape differs from a sentence round's; same retention policy.
  wordRounds: Record<string, WordRoundProgress>;
  // Last-played language: seeds the `/` redirect so a return visit lands where you
  // last played (falls back to the browser language, then English).
  lastLang: string | null;
  // Last-played MODE (#156): arrival lands on it (like lastLang) — the `/` redirect
  // sends a word-mode player to /<lang>/word. Switching modes is a deliberate act
  // (the header's Whippin mark opens the mode chooser); this only decides where "/" lands.
  lastMode: Mode | null;
  // The onboarding tutorial (#51) has been completed or skipped. Global, not
  // per-language — the mechanic is the same in both.
  onboarded: boolean;
  // Which #190 board tab is up — FRIENDS (the trusted default) or GLOBAL. It belongs to
  // the current VISIT to the leaderboard, not to the player (user feedback 2026-08-20,
  // narrowing the first cut, which made it a standing preference). Two things remount
  // that screen without ending the visit — a page REFRESH and a header MODE SWITCH (App
  // keys it on lang:mode) — and both were dropping a player who had chosen GLOBAL back
  // onto FRIENDS. So it is PERSISTED, which is the only way to survive the reload; and
  // App RESETS it the moment a non-board route renders, which is what ends the visit.
  // That reset lives in App rather than at each entry point precisely because an entry
  // that forgot it would silently reopen on the old tab forever.
  boardTab: BoardTab;
  // The sentence game's one-time instructions gate has been passed (2026-08-11). Unlike
  // Word mode's gate — whose START is mandatory because it starts the clock — the sentence
  // gate exists only to state the rules, so it is shown ONCE ever, globally: the rules are
  // the same in both languages and on every day.
  sentenceRulesSeen: boolean;
  // Per-language SET of solved game days (ascending, deduped dayNumbers). The raw fact,
  // not the derived stat: the streak counters (current/best) are DERIVED from this at read
  // time (game/streak.ts), never persisted (#56). The day-set shape is what makes a future
  // cross-device merge a set union + recompute, so it is purely client-side by decision
  // (2026-07-07). Bounded to the most recent MAX_SOLVED_DAYS per language.
  solvedDays: Record<string, number[]>;
}

interface GameState extends PersistedState {
  // Where each round's AUTHORITATIVE state is (#214). NOT persisted, deliberately: the
  // server owns the log, the client holds its last answer for as long as the tab lives,
  // and a new visit asks again rather than replaying a mirror that may be stale. Both
  // modes register here — both read the server log, with Word doing so once its run has
  // been submitted and its persisted outbox cleared.
  roundLoads: Record<string, RoundLoad>;

  // Word mode's twin (#156): the word round being played. NOT persisted; set by
  // ensureWordRound. recordWordGuess targets wordRounds[activeWordKey].
  activeWordKey: string | null;

  // The tutorial currently on screen (transient, NOT persisted): 'first' = the run a
  // newcomer accepted from the invitation, 'replay' = summoned via the header's "?".
  // It lives in the store (not GameRoute state) so it survives the /select
  // round-trip — the tutorial's flag goes through the REAL language screen, and
  // picking a language there returns INTO the tutorial in that language.
  tutorialOpen: 'first' | 'replay' | null;
  openTutorial: (kind: 'first' | 'replay') => void;
  closeTutorial: () => void;

  // Where the #188 profile editor should return to (transient, NOT persisted), for the
  // tutorialOpen reason: `/profile` is a GLOBAL route, so once it is open the board that
  // opened it is no longer in the URL. Rebuilding the return from lastLang/lastMode
  // guesses — those describe the last loaded GAME, so editing from the Word board could
  // land the player back on the Sentence one, and a board opened before ever playing
  // could come back in another language. The opener states its own route instead; an
  // editor reached with nothing set (a deep link, a reload) falls back to the guess.
  profileReturn: string | null;
  setProfileReturn: (path: string | null) => void;

  // Remember the last-played language (drives the `/` redirect). Ignores non-languages.
  setLastLang: (lang: string) => void;

  // Remember the last-played mode (#156, drives where `/` lands).
  setLastMode: (mode: Mode) => void;

  // Which board tab is up (#190), and the end of a visit to it: FRIENDS again.
  setBoardTab: (tab: BoardTab) => void;
  resetBoardTab: () => void;

  // Mark the onboarding tutorial as seen (finish AND skip both count — never re-nag).
  setOnboarded: () => void;

  // Mark the sentence game's one-time instructions gate as passed (its PLAY tap).
  markSentenceRulesSeen: () => void;

  // Record a solved game day for the streak (#56). No-op when `solvedDay` is already in
  // the set (re-solves / rehydration never double-count) OR when `solvedDay < activeDay -
  // 1` (days OLDER than yesterday are archive plays (#55) and must NOT touch the streak).
  // The activeDay-1 case is KEPT because it is the genuine flip-edge — an undated in-flight
  // round finished just past the 22:00 flip. That case is indistinguishable HERE from an
  // archive replay of yesterday, so the ACTIVE-DAY gate lives at the caller (Game.tsx);
  // recordSolve only ever sees active-day solves. Otherwise inserts, keeping the array
  // sorted + deduped and bounded to MAX_SOLVED_DAYS.
  // Returns true only when this call actually inserts a new day. The fresh-solve UI uses
  // that signal to avoid replaying historical streak progression after a same-day re-solve
  // (for example when a re-published puzzle reset the round but not the solved-day fact).
  recordSolve: (lang: string, solvedDay: number, activeDay: number) => boolean;

  // Reconcile the persisted OUTBOX to `key` playing `puzzle` (#214). An outbox naming a
  // DIFFERENT published revision is DROPPED — its guesses answered a retired question —
  // and any legacy non-day key goes with it; the map is then bounded by the same
  // most-recent cap the word rounds use. Called before the round's first render, so no
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

  // Where a round's authoritative state is. The sync engine is the only writer: 'loading'
  // while its read is out, 'ready' with the server's own state, 'failed' when the read
  // could not be had — which the screen shows rather than starting from a guess. `null`
  // FORGETS a round, which the engine does when it evicts that round's conversation: the
  // flight is what owns the state, and the next mount reads it again.
  setRoundLoad: (key: string, load: RoundLoad | null) => void;

  // Reconcile the persisted WORD rounds to `key` (#156): a matching key playing the SAME
  // word rehydrates untouched; a new key — or a republished different word under the same
  // (day, lang) — starts fresh. Same retention/cap policy as ensureRound.
  ensureWordRound: (key: string, word: string) => void;

  // ANCHOR a word round's clock (#163, server-stamped since #202): the sync engine has an
  // answer carrying the SERVER's `startedAt`, translated into this device's clock, and
  // stamps it here — opening the deadline at the full START_SECONDS. Keyed rather than
  // active-keyed, because the answer can land after navigation has moved on.
  //
  // Idempotent — a round already anchored keeps its clock, so a re-render, a double tap, a
  // re-read and a rehydration can never restart or shift a run. That is the whole no-retry
  // rule, and it lives here so no render path can reopen a finished day.
  anchorWordRun: (key: string, startedAt: number) => void;

  // Settle a Word run from the server's authoritative recorded log (#214). Its persisted
  // guesses were an outbox and are now acknowledged, so clear them even when another
  // device's first-write-wins log differs. Clamp a still-live deadline to now: a settled
  // run must stop accepting input immediately, while an already-finished one never reopens.
  settleWordRun: (key: string, claimed: number) => void;

  // Count one Word mode guess (a claim or a near/off-map miss — free guesses never reach
  // here) on the active word round: check the guess against the DEADLINE as of now,
  // append it, then re-price the whole resulting log so the cached claim count and the
  // deadline both describe exactly what is stored beside them. `replay` is the pure model
  // (game/wordGame.ts replayWordRun) closed over this puzzle's ranks — see WordRunCache
  // for why the store replays instead of being handed the numbers.
  //
  // RETURNS whether the guess actually LANDED, and the caller owes it a check. The screen
  // decides what to show from `playing`, which is a rendered value and therefore lags the
  // real clock by up to a frame; this reads `Date.now()` at the instant of the write. Both
  // must agree or the player is told they claimed something the run never took — a float,
  // a `+21s` gain and a spoken "claimed …" for a guess that changed nothing.
  recordWordGuess: (typed: string, replay: (tried: string[]) => WordRunCache) => boolean;
}

// Persistence is browser-only; in tests / SSR there is no localStorage, so fall back
// to a no-op store (no warnings, no persistence) instead of throwing.
const storage = createJSONStorage<PersistedState>(() => {
  if (typeof window === 'undefined') {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
  return window.localStorage;
});

// Version upgrades for the persisted blob (exported for the invariant tests).
//   v0 was a single top-level round ({ roundKey, holes, ... }); the shape is now a keyed
//     map, so discard the old state rather than mis-merge it (one-time reset).
//   v1 may still carry the RETIRED keyboard `layout` preference (removed with the AZERTY
//     layout) — picking only the current fields silently drops it. v1 also predates the
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
//   v6 adds Word mode (#156): the `wordRounds` map and `lastMode`. Older blobs get an
//     empty map and no mode preference (arrival stays on the sentence until a word round
//     is played).
//   v7 RETIMES those word rounds (#163): the strike count gave way to a countdown, so a
//     round now carries `startedAt`/`deadline` and no `ended`. A v6 word round has no
//     clock and no way to invent one — it recorded a run under rules that no longer
//     exist — so every one of them is DROPPED (the standing no-back-compat rule; the
//     sentence rounds, the solved days and the streak are untouched). The cost is a
//     device-local word history that predates the timer, which is pre-launch data.
//   v8 adds `sentenceRulesSeen` (2026-08-11): the sentence game's one-time instructions
//     gate. Older blobs get false — deliberately NOT grandfathered the way `onboarded`
//     is, because the gate teaches the history tap, which is newer than any existing
//     player's play state; every player sees it exactly once.
//   v9 adds `boardTab` (2026-08-20): which #190 board tab is up. Older blobs get
//     'friends', the default the screen already opens on, so nothing changes for anyone
//     already using it. It is persisted only so a REFRESH does not end a visit to the
//     board — App clears it on leaving one — so a stored 'global' is at most one
//     interrupted visit old, never a preference to honour forever.
//   v11 SERVER-ANCHORS the word rounds (#202): a run's `startedAt` is the server's stamp
//     now, and a v10 word round's is a local `Date.now()` the server never saw. There is no
//     honest way to invent the missing record — its end-of-run submission would be refused
//     as `not_started`, and its clock is unauditable — so every one of them is DROPPED,
//     exactly as v7 dropped the pre-clock strike runs (the standing no-back-compat rule).
//     Sentence rounds, solved days, the streak and the mode preference are untouched; the
//     cost is a device-local word history that predates the server's clock, which is
//     pre-launch data.
//   v10 retires `scoreSubmitted` (2026-08-20): a finished round now asks the population
//     until the population HOLDS it, so `scoreRecorded` alone settles a round and the old
//     flag has no reader. It is STRIPPED rather than left as unread cruft (the v1 keyboard
//     `layout` precedent), and stripping is also what HEALS the rounds it stranded — every
//     round a 4xx burned (and, before the 2026-08-16 correction, every 5xx too) carried the
//     flag with no recorded score, and now submits again on the next visit to its solved
//     screen.
//   v12 retires `scoreRecorded` from BOTH round maps (#203): there is no client-claimed
//     score left to reconcile — the server derives it from the guess log and records the
//     row itself — so what a finished round persists is `recorded`, a plain "the server
//     holds this round's solve", written from the round answers rather than from a score
//     POST. STRIPPED, not translated (the v10 precedent, and the standing no-back-compat
//     rule): a word round already carries `submitted` for exactly this, and a sentence
//     round appended to AFTER this ships re-learns the fact from the answer that says
//     `solved`.
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
//     exactly as v7 dropped the pre-clock strike runs and v11 the pre-#202 word rounds, so
//     every round that survives carries a revision by construction and no read path needs a
//     branch for one that does not. Solved days, the streak, the mode preference and the
//     word rounds are untouched; the cost is device-local sentence play at most a day old,
//     against an archive wiped before launch.
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
//     last flush, at most one round's worth. `solvedDays`, the streak, the word rounds and
//     every preference are untouched (the sentence archive/chooser/streak get their
//     server-backed source in #211, which ships with this).
function dropRetiredScoreFields<T>(rounds: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(rounds).map(([key, round]) => {
      const {
        scoreSubmitted: _submitted,
        scoreRecorded: _recorded,
        ...rest
      } = round as T & { scoreSubmitted?: boolean; scoreRecorded?: number };
      return [key, rest as T];
    }),
  );
}

export function migratePersisted(persisted: unknown, version: number): PersistedState {
  if (version < 1) {
    return {
      outbox: {},
      wordRounds: {},
      lastLang: null,
      lastMode: null,
      onboarded: false,
      boardTab: 'friends',
      sentenceRulesSeen: false,
      solvedDays: {},
    };
  }
  const p = persisted as Partial<PersistedState> & { rounds?: Record<string, unknown> };
  const lastLang = p.lastLang ?? null;
  // Grandfathering asks whether this person has PLAYED before, which the RAW blob answers —
  // including through the `rounds` map v14 drops, since a veteran whose only signal is their
  // play history must not be handed the tutorial back.
  const onboarded =
    typeof p.onboarded === 'boolean'
      ? p.onboarded
      : Object.keys(p.rounds ?? {}).length > 0 || lastLang != null;
  const solvedDays = p.solvedDays ?? {};
  // Word rounds only survive from v11 on: before v7 they were strike runs, and before v11
  // their clock was a local stamp no server ever saw (see the notes above). A v11 one CAN
  // carry `scoreRecorded`, so it is stripped.
  const wordRounds = version < 11 ? {} : dropRetiredScoreFields(p.wordRounds ?? {});
  const lastMode = p.lastMode === 'word' || p.lastMode === 'sentence' ? p.lastMode : null;
  const sentenceRulesSeen = p.sentenceRulesSeen === true;
  const boardTab = p.boardTab === 'global' ? 'global' : 'friends';
  // The outbox arrives with v14 and holds only UNACKNOWLEDGED guesses, which no older blob
  // can distinguish inside its merged `tried` list (see the v14 note) — so an older one
  // starts empty rather than re-sending a log the server already holds.
  const outbox = version < 14 ? {} : p.outbox ?? {};
  return {
    outbox,
    wordRounds,
    lastLang,
    lastMode,
    onboarded,
    boardTab,
    sentenceRulesSeen,
    solvedDays,
  };
}

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
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
      tutorialOpen: null,
      profileReturn: null,

      openTutorial: (kind) => set({ tutorialOpen: kind }),
      closeTutorial: () => set({ tutorialOpen: null }),
      setProfileReturn: (path) => set({ profileReturn: path }),

      setLastLang: (lang) => {
        if (!isLang(lang) || get().lastLang === lang) return;
        set({ lastLang: lang });
      },

      setLastMode: (mode) => {
        if (get().lastMode === mode) return;
        set({ lastMode: mode });
      },

      setBoardTab: (tab) => {
        if (get().boardTab === tab) return;
        set({ boardTab: tab });
      },

      // Leaving the leaderboard ends the visit. Guarded like every other setter, so the
      // non-board routes this fires on do not each rewrite the persisted blob.
      resetBoardTab: () => {
        if (get().boardTab === 'friends') return;
        set({ boardTab: 'friends' });
      },

      setOnboarded: () => {
        if (get().onboarded) return;
        set({ onboarded: true });
      },

      markSentenceRulesSeen: () => {
        if (get().sentenceRulesSeen) return;
        set({ sentenceRulesSeen: true });
      },

      recordSolve: (lang, solvedDay, activeDay) => {
        // Archive plays (a solve older than yesterday) NEVER touch the streak; an
        // in-flight round solved just past the 22:00 flip (solvedDay === activeDay - 1)
        // still counts for its own day.
        if (solvedDay < activeDay - 1) return false;
        const state = get();
        const days = state.solvedDays[lang] ?? [];
        // Re-solves and rehydration must not double-count — and must not replay the
        // celebration as though this historical insertion had happened again.
        if (days.includes(solvedDay)) return false;
        // Insert keeping the array sorted ascending + deduped, then bound it.
        const next = capSolvedDays([...days, solvedDay].sort((a, b) => a - b));
        set({ solvedDays: { ...state.solvedDays, [lang]: next } });
        return true;
      },

      ensureOutbox: (key, puzzle) =>
        set((s) => {
          const existing = s.outbox[key];
          const kept = { ...s.outbox };
          // A DIFFERENT published revision means the puzzle contained an error and this
          // round starts over (#203), so what the outbox holds is answers to a retired
          // question: dropped, never sent.
          //
          // **`solvedDays` is deliberately NOT touched.** A republish is OUR error, not the
          // player's, and the streak is a reward for showing up — taking a day back because
          // we shipped a broken puzzle would punish them for it. So the credit stands, and
          // solving the corrected version cannot claim it twice (`recordSolve` already
          // refuses a day it holds), which is the same rule a re-solve has always followed.
          if (existing && existing.puzzle !== puzzle) delete kept[key];
          // Retention: keep every day-keyed outbox (an archive day left offline still owes
          // its guesses), drop any legacy non-day key, bound the map.
          return { outbox: capDayKeyed(kept, key) };
        }),

      appendOutbox: (key, puzzle, typed) =>
        set((s) => {
          const existing = s.outbox[key];
          // Most guesses arrive with NOTHING to append into: an accepted write removes the
          // outbox it emptied, so a round that is caught up owes no entry at all. Minting
          // one here is what makes the buffer work at all — and it takes the revision from
          // the caller, which is playing it, rather than guessing.
          const guesses = existing && existing.puzzle === puzzle ? existing.guesses : [];
          return { outbox: { ...s.outbox, [key]: { puzzle, guesses: [...guesses, typed] } } };
        }),

      setOutbox: (key, puzzle, guesses) =>
        set((s) => {
          const existing = s.outbox[key];
          // An answer about a RETIRED revision writes nothing: the flight has already been
          // reset to read again, and resurrecting its guesses into the round that replaced
          // it is exactly what the revision exists to prevent.
          if (!existing || existing.puzzle !== puzzle) return {};
          // An emptied outbox is REMOVED rather than kept as `[]`: a caught-up device
          // persists no sentence rounds at all, which is the whole point of the model.
          if (guesses.length === 0) {
            const { [key]: _done, ...rest } = s.outbox;
            return { outbox: rest };
          }
          return { outbox: { ...s.outbox, [key]: { puzzle, guesses } } };
        }),

      setRoundLoad: (key, load) =>
        set((s) => {
          if (load === null) {
            if (!(key in s.roundLoads)) return {};
            const { [key]: _gone, ...rest } = s.roundLoads;
            return { roundLoads: rest };
          }
          return { roundLoads: { ...s.roundLoads, [key]: load } };
        }),

      ensureWordRound: (key, word) =>
        set((s) => {
          // Same retention story as the outbox: keep every day-keyed word round (the
          // archive rehydrates past days), drop anything else, bound the map.
          const existing = s.wordRounds[key];
          const kept = {
            ...s.wordRounds,
            [key]:
              existing && existing.word === word
                ? existing
                : { word, startedAt: null, deadline: null, tried: [], claimed: 0 },
          };
          return { activeWordKey: key, wordRounds: capDayKeyed(kept, key) };
        }),

      anchorWordRun: (key, startedAt) =>
        set((s) => {
          const round = s.wordRounds[key];
          // Already running (or already run out): the clock is stamped once and never
          // re-stamped — a re-read must not shift a run under the player.
          if (!round || round.startedAt !== null) return {};
          // A round with no start has no log (a guess can only land while running), so the
          // deadline opens at the bare START_SECONDS. On a device JOINING a run already in
          // progress the anchor is that far in the past already — but only the base sixty
          // seconds are known here: the bonuses the real run has claimed live in the other
          // device's log until it submits, so this clock runs SHORT and can call a live run
          // finished. Word mode streams nothing, so there is no way to price it better, and
          // the answer is that a joiner never WRITES (state/wordRoundSync.ts `mayWrite`)
          // rather than that its clock is right.
          return {
            wordRounds: {
              ...s.wordRounds,
              [key]: { ...round, startedAt, deadline: startedAt + runMs(0) },
            },
          };
        }),

      settleWordRun: (key, claimed) =>
        set((s) => {
          const round = s.wordRounds[key];
          if (!round) return {};
          // `claimed` is a persisted SUMMARY read by surfaces that do not load the rank
          // map. Keep its own store boundary inside the product's finite claim field even
          // if a malformed/corrupt authoritative log somehow reaches this action; no
          // calendar or chooser may render progress above 100%.
          const finiteClaimed = Number.isFinite(claimed) ? Math.trunc(claimed) : 0;
          const settledClaimed = Math.min(CLAIM_ZONE, Math.max(0, finiteClaimed));
          const settledDeadline =
            round.deadline === null ? null : Math.min(round.deadline, Date.now());
          if (
            round.submitted &&
            round.tried.length === 0 &&
            round.claimed === settledClaimed &&
            round.deadline === settledDeadline
          ) {
            return {};
          }
          return {
            wordRounds: {
              ...s.wordRounds,
              [key]: {
                ...round,
                tried: [],
                claimed: settledClaimed,
                deadline: settledDeadline,
                submitted: true,
              },
            },
          };
        }),

      // Reads through `get()` rather than a `set` updater because it has to REPORT what it
      // did. That is safe for the batched-submissions case the tests pin: zustand applies
      // `set` synchronously, so a second call in the same tick already sees the first's
      // log.
      recordWordGuess: (typed, replay) => {
        const s = get();
        const key = s.activeWordKey;
        if (!key) return false;
        const round = s.wordRounds[key];
        if (!round || round.submitted || round.startedAt === null || round.deadline === null) {
          return false;
        }

        const startedAt = round.startedAt;
        const price = (cache: WordRunCache) => ({
          claimed: cache.claimed,
          deadline: startedAt + runMs(cache.bonus),
        });

        // The guess is judged against the deadline AS OF NOW — a guess in flight when the
        // clock dies is dead — and against the deadline BEFORE this claim, so a claim
        // cannot pay for the moment it arrived in. A deadline already spent in the stored
        // round is FROZEN, repairs included: re-pricing it could move it later and bring a
        // finished run back to life.
        const now = Date.now();
        if (now > round.deadline) return false;

        // A same-word republish keeps the authoritative log but can change what its claims
        // are worth. Check the deadline implied by the CURRENT map before appending: the
        // stored deadline may still be live while the re-priced one is already spent, and
        // a new claim must not buy its way back across that gap. This repair is safe here
        // because the stored round was live at the start of the write; the guard above still
        // prevents a genuinely finished persisted round from being revived.
        const current = price(replay(round.tried));
        if (now > current.deadline) {
          if (round.claimed !== current.claimed || round.deadline !== current.deadline) {
            set({ wordRounds: { ...s.wordRounds, [key]: { ...round, ...current } } });
          }
          return false;
        }
        if (round.tried.includes(typed)) {
          // Nothing to append, but `tried` is authoritative and a same-word republish can
          // have changed what the SAME log is worth — repair the cached half rather than
          // leaving it describing an older rank map.
          if (round.claimed !== current.claimed || round.deadline !== current.deadline) {
            set({ wordRounds: { ...s.wordRounds, [key]: { ...round, ...current } } });
          }
          return false;
        }
        const tried = [...round.tried, typed];
        set({
          wordRounds: { ...s.wordRounds, [key]: { ...round, tried, ...price(replay(tried)) } },
        });
        return true;
      },

    }),
    {
      name: 'whippin-round',
      storage,
      version: 14, // v14: the sentence rounds map is gone; storage is an OUTBOX (see migratePersisted)
      migrate: migratePersisted,
      // Persist the sentence OUTBOX, the word rounds, last language/mode, the onboarding
      // flag and the solved-day sets; the round loads, the active word key and the actions
      // are transient. Each language's solved-day set is capped to MAX_SOLVED_DAYS on write.
      partialize: (s): PersistedState => ({
        outbox: s.outbox,
        wordRounds: s.wordRounds,
        lastLang: s.lastLang,
        lastMode: s.lastMode,
        boardTab: s.boardTab,
        onboarded: s.onboarded,
        sentenceRulesSeen: s.sentenceRulesSeen,
        solvedDays: capAllSolvedDays(s.solvedDays),
      }),
    },
  ),
);
