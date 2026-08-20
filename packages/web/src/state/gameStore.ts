import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RuntimeHole } from '@whippin/shared';
import { isLang, type Mode } from '../langs';
import { runMs } from '../game/wordGame';

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
  // The round's score has been submitted to the anonymous daily histogram (#170) — set
  // once the server ANSWERS the POST, accepted or refused. Guards revisits: a flagged
  // round only ever GETs the read-only histogram, never re-submits. Optional so every
  // pre-#170 persisted round stays valid with the flag simply unset.
  scoreSubmitted?: boolean;
  // The score the server actually RECORDED (#187) — the population is first-write-wins
  // per player, so a duplicate submission (another device/tab under the same key) is
  // answered with the STORED row's score, which can differ from this round's own count.
  // Revisit GETs locate the standing by this value; unset on a refused submission (the
  // population holds nothing for this round) and on pre-#187 rounds.
  scoreRecorded?: number;
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

// One Word mode round (#156, retimed by #163). `tried` is the SOURCE OF TRUTH — the
// counted guesses (folded, in order; free guesses never enter it), from which the whole
// run replays (game/wordGame.ts replayWordRun) — and `startedAt` is the second one: the
// wall-clock moment START was tapped.
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
  // null until START is tapped: a fetched-but-unplayed day sits at the rules gate, and
  // the clock has not begun.
  startedAt: number | null;
  deadline: number | null;
  tried: string[];
  claimed: number;
  // Same contract as RoundProgress.scoreSubmitted (#170): the finished run's claim count
  // went to the daily histogram; revisits GET instead of re-submitting.
  scoreSubmitted?: boolean;
  // Same contract as RoundProgress.scoreRecorded (#187): what the population holds.
  scoreRecorded?: number;
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

  // START the active word round's clock (#163): stamp `startedAt` NOW and open the
  // deadline at the full START_SECONDS. Idempotent — a round that has already started
  // keeps its clock, so a re-render, a double tap or a rehydration can never restart a
  // run (the daily is one-shot: no retry, no practice).
  startWordRun: () => void;

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
  recordGuess: (typed: string, keyOf?: (typed: string) => string) => void;

  // A warm hit improved a hole on the active round: swap in its closer (accented)
  // word + lower rank.
  improveHole: (index: number, word: string, rank: number) => void;

  // Mark THIS keyed round's score as submitted to the daily histogram (#170). The request
  // can finish after navigation has changed the active round, so completion must carry the
  // identity it started with rather than consulting activeKey at response time.
  // Idempotent: the flag only ever turns on. `recorded` is the score the server's
  // first-write-wins population actually holds for this round (#187) — persisted so a
  // revisit GET locates the standing by what was recorded, not by the local count a
  // duplicate submission failed to record; omitted on a refusal (nothing recorded).
  markScoreSubmitted: (key: string, recorded?: number) => void;
  markWordScoreSubmitted: (key: string, recorded?: number) => void;

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
export function migratePersisted(persisted: unknown, version: number): PersistedState {
  if (version < 1) {
    return {
      rounds: {},
      wordRounds: {},
      lastLang: null,
      lastMode: null,
      onboarded: false,
      sentenceRulesSeen: false,
      solvedDays: {},
    };
  }
  const p = persisted as Partial<PersistedState>;
  const rounds = p.rounds ?? {};
  const lastLang = p.lastLang ?? null;
  const onboarded =
    typeof p.onboarded === 'boolean'
      ? p.onboarded
      : Object.keys(rounds).length > 0 || lastLang != null;
  const solvedDays = p.solvedDays ?? {};
  // Word rounds only survive from v7 on: before it they were strike runs, and a strike
  // run cannot be re-read as a clock (see the v7 note above).
  const wordRounds = version < 7 ? {} : (p.wordRounds ?? {});
  const lastMode = p.lastMode === 'word' || p.lastMode === 'sentence' ? p.lastMode : null;
  const sentenceRulesSeen = p.sentenceRulesSeen === true;
  return { rounds, wordRounds, lastLang, lastMode, onboarded, sentenceRulesSeen, solvedDays };
}

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      rounds: {},
      wordRounds: {},
      lastLang: null,
      lastMode: null,
      onboarded: false,
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

      startWordRun: () =>
        set((s) => {
          const key = s.activeWordKey;
          if (!key) return {};
          const round = s.wordRounds[key];
          // Already running (or already run out): the clock is stamped once and never
          // re-stamped. This is the whole no-retry rule, and it lives here rather than in
          // the screen so no render path can reopen a finished day.
          if (!round || round.startedAt !== null) return {};
          const startedAt = Date.now();
          return {
            wordRounds: {
              ...s.wordRounds,
              [key]: { ...round, startedAt, deadline: startedAt + runMs(0) },
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

      recordGuess: (typed, keyOf = (t) => t) =>
        set((s) => {
          const key = s.activeKey;
          if (!key) return {};
          const round = s.rounds[key];
          if (!round) return {};
          // Dedupe: unique tries only, compared by canonical identity so an inflection
          // of an already-tried word never counts (nor enters the recall history).
          const guessId = keyOf(typed);
          if (round.tried.some((t) => keyOf(t) === guessId)) return {};
          return {
            rounds: {
              ...s.rounds,
              [key]: { ...round, tried: [...round.tried, typed], guessCount: round.guessCount + 1 },
            },
          };
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

      markScoreSubmitted: (key, recorded) =>
        set((s) => {
          const round = s.rounds[key];
          if (!round || round.scoreSubmitted === true) return {};
          return {
            rounds: {
              ...s.rounds,
              [key]: {
                ...round,
                scoreSubmitted: true,
                ...(recorded !== undefined ? { scoreRecorded: recorded } : {}),
              },
            },
          };
        }),

      markWordScoreSubmitted: (key, recorded) =>
        set((s) => {
          const round = s.wordRounds[key];
          if (!round || round.scoreSubmitted === true) return {};
          return {
            wordRounds: {
              ...s.wordRounds,
              [key]: {
                ...round,
                scoreSubmitted: true,
                ...(recorded !== undefined ? { scoreRecorded: recorded } : {}),
              },
            },
          };
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
      version: 8, // v8: the sentence gate's seen-once flag (see migratePersisted)
      migrate: migratePersisted,
      // Persist rounds (both modes'), last language/mode, the onboarding flag and the
      // solved-day sets; the active keys and the actions are transient. Each language's
      // solved-day set is capped to MAX_SOLVED_DAYS on write.
      partialize: (s): PersistedState => ({
        rounds: s.rounds,
        wordRounds: s.wordRounds,
        lastLang: s.lastLang,
        lastMode: s.lastMode,
        onboarded: s.onboarded,
        sentenceRulesSeen: s.sentenceRulesSeen,
        solvedDays: capAllSolvedDays(s.solvedDays),
      }),
    },
  ),
);
