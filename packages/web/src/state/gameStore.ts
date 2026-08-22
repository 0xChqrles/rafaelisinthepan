import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RuntimeHole } from '@whippin/shared';
import { isLang, type Mode } from '../langs';
import { runMs } from '../game/wordGame';

// Which crowd the #190 leaderboard is showing: the friends graph (the trusted default)
// or the global top 50. It lives here rather than in the screen because the screen
// remounts under it without the visit ending — see `boardTab` below.
export type BoardTab = 'friends' | 'global';

// A round is identified by its `roundKey` = (server day, language). The store keeps a
// MAP of rounds keyed by this string so progress in one language survives switching to
// another and back (the selector reads each language's status out of this map). The
// SAME key rehydrates its stored progress untouched. Day rounds are KEPT across days so
// the archive can rehydrate a past day's progress (#54); the map is bounded by a
// most-recent cap (MAX_DAY_ROUNDS). Every key is a day key — any legacy non-day round
// left in an older persisted blob is dropped on the next ensureRound.
export interface RoundProgress {
  holes: RuntimeHole[];
  // Score = number of unique valid tries.
  guessCount: number;
  // The deduped folded slugs already counted, kept as an array so the Set survives
  // JSON persistence.
  tried: string[];
  // Reconstruction progress (0–100), cached so the selector can badge an in-progress
  // language WITHOUT re-loading its puzzle's rank map. Game recomputes and syncs it;
  // it is derived UI state, never the source of truth for scoring.
  progress: number;
  // The SERVER has this round's solve on record (#203), which is when its score row
  // exists and a standing becomes readable. It is the server's own reading of the log it
  // stores — set by the sync engine off any answer that says `solved` — never this
  // device's board, which flips a beat earlier, before the solving append has landed.
  //
  // It replaced the recorded SCORE the round used to persist (#170/#187): there is no
  // client-claimed score left to reconcile against, so what a finished round needs to know
  // is only WHETHER the population holds it. Unset means it does not yet — the flush is
  // still in flight, was refused, or the round is simply unfinished — and the standing
  // stays blank until it lands. It is also the FREEZE: a solved round accepts no further
  // appends, so the conversation is over and a reload must not re-open it.
  recorded?: boolean;
  // The server refused further appends at the guess cap (#201): the round keeps playing
  // locally but has STOPPED COUNTING — it must never submit a score, so no leaderboard
  // entry can exist for it. Set only by the sync engine on the server's round_full
  // refusal; never cleared (a capped round stays capped).
  capped?: boolean;
}

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

// Retention cap: keep at most this many day rounds (newest by dayNumber). ~800 ≈ a year
// of daily play in two languages with headroom; rounds are small (holes + tried list),
// so the map stays well under localStorage limits.
const MAX_DAY_ROUNDS = 800;

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

// Enforce the cap: with more than MAX_DAY_ROUNDS rounds, drop the oldest (lowest
// dayNumber), always keeping the active key. ensureRound has already filtered the map to
// day keys, so every entry here is a day round.
function capDayRounds(
  rounds: Record<string, RoundProgress>,
  activeKey: string,
): Record<string, RoundProgress> {
  const dayKeys = Object.keys(rounds);
  if (dayKeys.length <= MAX_DAY_ROUNDS) return rounds;
  const survivors = new Set(
    dayKeys.sort((a, b) => dayNumberOf(b)! - dayNumberOf(a)!).slice(0, MAX_DAY_ROUNDS),
  );
  survivors.add(activeKey);
  const out: Record<string, RoundProgress> = {};
  for (const [k, v] of Object.entries(rounds)) {
    if (survivors.has(k)) out[k] = v;
  }
  return out;
}

// One Word mode round (#156, retimed by #163, server-anchored by #202). `tried` is the
// SOURCE OF TRUTH — the counted guesses (folded, in order; free guesses never enter it),
// from which the whole run replays (game/wordGame.ts replayWordRun) — and `startedAt` is
// the second one: when the run began.
//
// Since #202 that instant is the SERVER's, translated into this device's clock: the sync
// engine reads `startedAt` and the server's own `now` off the round-start answer and
// anchors `Date.now() - (now - startedAt)`. It holds an ELAPSED SPAN rather than an
// instant, so a device whose clock is minutes off still runs a 60-second run — and the
// request's own travel time lands INSIDE the run, which is what keeps an honest submission
// clear of the server's end-of-run wait check.
//
// `deadline` is DERIVED from those two (startedAt + runMs of the log's claimed bonuses)
// and recomputed on every write, so the clock can never drift away from the guesses that
// bought it. It is nevertheless PERSISTED, because it is the ONE thing the status
// surfaces need and the one thing they cannot compute: the archive and the choosers badge
// a day without loading its rank map, so they cannot replay the log to price it.
//
// There is NO `ended` field. Whether a run is over is `now > deadline`, wall-clock and
// always current — a stored boolean would be a second answer to the same question, stale
// the moment the tab is closed (which is exactly the case the no-pause rule is about).
// `claimed` stays a cached derived value for those same status surfaces, like
// RoundProgress.progress; never the source of truth. `word` is the day's word slug: a
// republished different word under the same (day, lang) key resets the round instead of
// replaying a stale log against the new map.
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

// Enforce the word-round cap, mirroring capDayRounds below.
function capWordRounds(
  rounds: Record<string, WordRoundProgress>,
  activeKey: string,
): Record<string, WordRoundProgress> {
  const keys = Object.keys(rounds);
  if (keys.length <= MAX_DAY_ROUNDS) return rounds;
  const survivors = new Set(
    keys.sort((a, b) => dayNumberOf(b)! - dayNumberOf(a)!).slice(0, MAX_DAY_ROUNDS),
  );
  survivors.add(activeKey);
  const out: Record<string, WordRoundProgress> = {};
  for (const [k, v] of Object.entries(rounds)) {
    if (survivors.has(k)) out[k] = v;
  }
  return out;
}

// Do the stored round's holes still describe THIS puzzle? A round key is only
// (day, lang), so re-publishing a DIFFERENT sentence for the same day+lang keeps the key
// but changes the holes. Rehydrating the old holes then feeds secrets that are absent
// from the new `ranks` into scoring (Object.keys(ranks[secret]) -> throws -> black
// screen). Match by position + secret so a changed sentence is reset, not rehydrated.
export function holesMatchPuzzle(stored: RuntimeHole[], puzzle: RuntimeHole[]): boolean {
  return (
    stored.length === puzzle.length &&
    puzzle.every((h, i) => stored[i].pos === h.pos && stored[i].secret === h.secret)
  );
}

interface PersistedState {
  // All rounds keyed by roundKey. Day rounds accumulate across days (archive history),
  // bounded to the MAX_DAY_ROUNDS most recent by ensureRound.
  rounds: Record<string, RoundProgress>;
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
  // The round currently being played (its key). NOT persisted: ensureRound sets it each
  // load from the active puzzle's (day, lang). The mutating actions target rounds[activeKey].
  activeKey: string | null;

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

  // Reconcile the persisted rounds to `key`. A matching key with matching holes
  // rehydrates its stored progress; a brand-new key — or the same key whose puzzle was
  // re-published with a different sentence — starts fresh from `initialHoles`. Keeps
  // every day round (the archive needs history), drops any legacy non-day round, then
  // bounds the map with the MAX_DAY_ROUNDS most-recent cap.
  ensureRound: (key: string, initialHoles: RuntimeHole[]) => void;

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

  // Adopt the RECORDED run the server holds for this word round (#202) — a device that
  // never played it picking up the day's history. Only ever into an EMPTY local log: a
  // word round's deadline is DERIVED from its log, so adopting a longer one over a run
  // this device actually played could move the clock, and a finished run must never
  // re-open. Handed finished values like `adoptRound`, for the same reason.
  adoptWordRun: (key: string, run: { tried: string[] } & WordRunCache) => void;

  // The server has acknowledged this round's end-of-run log (#202).
  markWordSubmitted: (key: string) => void;

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

  // Count a valid guess on the active round. Deduped by the caller-supplied canonical
  // identity (#104: inflections of one word are ONE try — Game passes guessKey over the
  // puzzle's ranks; defaults to the folded slug itself): a repeat neither re-counts nor
  // re-appends. `typed` is already folded by the caller. Identity is recomputed from the
  // persisted `tried` slugs, so the stored shape is unchanged and old rounds just work.
  //
  // RETURNS whether the guess actually entered the log, so the caller knows whether the
  // sync engine has anything new to flush (#201) — a deduped repeat changed nothing.
  recordGuess: (typed: string, keyOf?: (typed: string) => string) => boolean;

  // Adopt the server's answer as this round's truth (#201): replace `tried` with the
  // merged log (server entries first, then local-only ones — computed by the sync
  // engine, which owns the interpretation) and replay the hole states beside it. The
  // store stays interpretation-free on purpose: like recordWordGuess's replay callback,
  // it is handed finished values rather than rank maps it must not know — the cached
  // `progress` included, because `syncProgress` can only ever repair the ACTIVE round
  // and an adoption routinely lands after the player has navigated away.
  adoptRound: (key: string, tried: string[], holes: RuntimeHole[], progress: number) => void;

  // Mark the active-keyed round CAPPED (#201): the server refused further appends at
  // ROUND_GUESS_CAP, so the round stops counting and must never submit a score.
  markRoundCapped: (key: string) => void;

  // A warm hit improved a hole on the active round: swap in its closer (accented)
  // word + lower rank.
  improveHole: (index: number, word: string, rank: number) => void;

  // The SERVER holds THIS keyed round's solve (#203) — read off a round answer's `solved`,
  // never off the local board. Keyed rather than active-keyed because an answer routinely
  // lands after navigation has moved on. Idempotent, and only ever set.
  markRoundRecorded: (key: string) => void;

  // Cache the active round's reconstruction progress (for the selector badge). No-op
  // when unchanged so it never churns the store.
  syncProgress: (value: number) => void;
}

// Persistence is browser-only; in tests / SSR there is no localStorage, so fall back
// to a no-op store (no warnings, no persistence) instead of throwing.
const storage = createJSONStorage<PersistedState>(() => {
  if (typeof window === 'undefined') {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
  return window.localStorage;
});

function freshRound(initialHoles: RuntimeHole[]): RoundProgress {
  return { holes: initialHoles, guessCount: 0, tried: [], progress: 0 };
}

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
      rounds: {},
      wordRounds: {},
      lastLang: null,
      lastMode: null,
      onboarded: false,
      boardTab: 'friends',
      sentenceRulesSeen: false,
      solvedDays: {},
    };
  }
  const p = persisted as Partial<PersistedState>;
  const rounds = dropRetiredScoreFields(p.rounds ?? {});
  const lastLang = p.lastLang ?? null;
  const onboarded =
    typeof p.onboarded === 'boolean'
      ? p.onboarded
      : Object.keys(rounds).length > 0 || lastLang != null;
  const solvedDays = p.solvedDays ?? {};
  // Word rounds only survive from v11 on: before v7 they were strike runs, and before v11
  // their clock was a local stamp no server ever saw (see the notes above). A v11 one CAN
  // carry `scoreRecorded`, so it is stripped like a sentence round's.
  const wordRounds = version < 11 ? {} : dropRetiredScoreFields(p.wordRounds ?? {});
  const lastMode = p.lastMode === 'word' || p.lastMode === 'sentence' ? p.lastMode : null;
  const sentenceRulesSeen = p.sentenceRulesSeen === true;
  const boardTab = p.boardTab === 'global' ? 'global' : 'friends';
  return {
    rounds,
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

      ensureRound: (key, initialHoles) =>
        set((s) => {
          // Retention: keep EVERY day round regardless of its day — the archive rehydrates
          // a past day's progress, so a new day must not wipe yesterday's (#54). Any legacy
          // non-day round (an old ?puzzle= override left in persisted storage) is dropped.
          const kept: Record<string, RoundProgress> = {};
          for (const [k, v] of Object.entries(s.rounds)) {
            if (dayNumberOf(k) !== null) kept[k] = v; // day round — always retained
          }
          // Same key + matching holes -> rehydrate untouched; a brand-new key OR a
          // re-published sentence under the same (day, lang) key (holes no longer match)
          // -> fresh from initialHoles, so stale holes never reach scoring.
          const existing = s.rounds[key];
          kept[key] =
            existing && holesMatchPuzzle(existing.holes, initialHoles)
              ? existing
              : freshRound(initialHoles);
          // Bound the map: evict the oldest day rounds beyond MAX_DAY_ROUNDS.
          return { activeKey: key, rounds: capDayRounds(kept, key) };
        }),

      ensureWordRound: (key, word) =>
        set((s) => {
          // Same retention story as ensureRound: keep every day-keyed word round (the
          // archive rehydrates past days), drop anything else, bound the map.
          const kept: Record<string, WordRoundProgress> = {};
          for (const [k, v] of Object.entries(s.wordRounds)) {
            if (dayNumberOf(k) !== null) kept[k] = v;
          }
          const existing = s.wordRounds[key];
          kept[key] =
            existing && existing.word === word
              ? existing
              : { word, startedAt: null, deadline: null, tried: [], claimed: 0 };
          return { activeWordKey: key, wordRounds: capWordRounds(kept, key) };
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

      adoptWordRun: (key, run) =>
        set((s) => {
          const round = s.wordRounds[key];
          // Nothing to adopt INTO (the round was evicted or reset under this key), no
          // clock to price the log against, or a log of this device's own — see the type
          // above for why the last one is left alone.
          if (!round || round.startedAt === null || round.tried.length > 0) return {};
          return {
            wordRounds: {
              ...s.wordRounds,
              [key]: {
                ...round,
                tried: run.tried,
                claimed: run.claimed,
                deadline: round.startedAt + runMs(run.bonus),
              },
            },
          };
        }),

      markWordSubmitted: (key) =>
        set((s) => {
          const round = s.wordRounds[key];
          if (!round || round.submitted) return {};
          return { wordRounds: { ...s.wordRounds, [key]: { ...round, submitted: true } } };
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
        if (!round || round.startedAt === null || round.deadline === null) return false;

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

      // Reads through `get()` rather than a `set` updater because it has to REPORT what
      // it did. That is safe for the batched-submissions case the tests pin: zustand
      // applies `set` synchronously, so a second call in the same tick already sees the
      // first's log. (The same reasoning recordWordGuess relies on.)
      recordGuess: (typed, keyOf = (t) => t) => {
        const s = get();
        const key = s.activeKey;
        if (!key) return false;
        const round = s.rounds[key];
        if (!round) return false;
        // Dedupe: unique tries only, compared by canonical identity so an inflection
        // of an already-tried word never counts (nor enters the recall history).
        const guessId = keyOf(typed);
        if (round.tried.some((t) => keyOf(t) === guessId)) return false;
        set({
          rounds: {
            ...s.rounds,
            [key]: { ...round, tried: [...round.tried, typed], guessCount: round.guessCount + 1 },
          },
        });
        return true;
      },

      adoptRound: (key, tried, holes, progress) =>
        set((s) => {
          // The round can be gone by the time an answer lands — evicted by capDayRounds,
          // or reset under this key by a republish. There is nothing to adopt INTO, and
          // materializing one here would create a round with no cached progress, which
          // the archive then paints as a NaN% cell.
          const round = s.rounds[key];
          if (!round) return {};
          // The score IS the number of unique tries, and the merged log is deduped by
          // construction — derive the count rather than storing a second answer to it.
          // `progress` travels WITH the board it describes, for the reason in the type
          // above: nothing else will refresh it once this round stops being active.
          return {
            rounds: {
              ...s.rounds,
              [key]: { ...round, tried, holes, guessCount: tried.length, progress },
            },
          };
        }),

      markRoundCapped: (key) =>
        set((s) => {
          const round = s.rounds[key];
          if (!round || round.capped) return {};
          return { rounds: { ...s.rounds, [key]: { ...round, capped: true } } };
        }),

      improveHole: (index, word, rank) =>
        set((s) => {
          const key = s.activeKey;
          if (!key) return {};
          const round = s.rounds[key];
          if (!round) return {};
          // Monotonic: Game defers each swap to its floating hit's fade-out, so a second
          // guess submitted inside that window decided "improves" against a rank that a
          // pending timer was about to lower. Applying it blindly would REGRESS the hole
          // (or un-solve a just-solved one) when its timer fires after a better one's.
          // A swap only ever moves a hole strictly closer.
          const hole = round.holes[index];
          if (!hole || rank >= hole.rank) return {};
          return {
            rounds: {
              ...s.rounds,
              [key]: {
                ...round,
                holes: round.holes.map((h, i) => (i === index ? { ...h, word, rank } : h)),
              },
            },
          };
        }),

      markRoundRecorded: (key) =>
        set((s) => {
          const round = s.rounds[key];
          if (!round || round.recorded) return {};
          return { rounds: { ...s.rounds, [key]: { ...round, recorded: true } } };
        }),

      syncProgress: (value) =>
        set((s) => {
          const key = s.activeKey;
          if (!key) return {};
          const round = s.rounds[key];
          if (!round || round.progress === value) return {};
          return { rounds: { ...s.rounds, [key]: { ...round, progress: value } } };
        }),
    }),
    {
      name: 'whippin-round',
      storage,
      version: 12, // v12: the recorded SCORE is retired; the server derives it (#203)
      migrate: migratePersisted,
      // Persist rounds (both modes'), last language/mode, the onboarding flag and the
      // solved-day sets; the active keys and the actions are transient. Each language's
      // solved-day set is capped to MAX_SOLVED_DAYS on write.
      partialize: (s): PersistedState => ({
        rounds: s.rounds,
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
