import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RuntimeHole } from '@whippin/shared';
import { isLang } from '../langs';

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
}

// The canonical round key: (server day, language). Kept here so Game (which builds it)
// and the selector (which looks it up per language) agree byte-for-byte.
export function roundKeyForDay(dayNumber: number, lang: string): string {
  return `d:${dayNumber}:${lang}`;
}

// The dayNumber a day-keyed round belongs to, or null for a legacy non-day key. Orders
// day rounds newest-first for the retention cap, and marks legacy rounds for dropping.
function dayNumberOf(key: string): number | null {
  const m = /^d:(\d+):/.exec(key);
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
  // Last-played language: seeds the `/` redirect so a return visit lands where you
  // last played (falls back to the browser language, then English).
  lastLang: string | null;
  // The onboarding tutorial (#51) has been completed or skipped. Global, not
  // per-language — the mechanic is the same in both.
  onboarded: boolean;
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

  // The tutorial currently on screen (transient, NOT persisted): 'first' = the run a
  // newcomer accepted from the invitation, 'replay' = summoned via the header's "?".
  // It lives in the store (not GameRoute state) so it survives the /select
  // round-trip — the tutorial's flag goes through the REAL language screen, and
  // picking a language there returns INTO the tutorial in that language.
  tutorialOpen: 'first' | 'replay' | null;
  openTutorial: (kind: 'first' | 'replay') => void;
  closeTutorial: () => void;

  // Remember the last-played language (drives the `/` redirect). Ignores non-languages.
  setLastLang: (lang: string) => void;

  // Mark the onboarding tutorial as seen (finish AND skip both count — never re-nag).
  setOnboarded: () => void;

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

  // Count a valid guess on the active round. Deduped by folded slug: a repeat neither
  // re-counts nor re-appends. `typed` is already folded by the caller.
  recordGuess: (typed: string) => void;

  // A warm hit improved a hole on the active round: swap in its closer (accented)
  // word + lower rank.
  improveHole: (index: number, word: string, rank: number) => void;

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
export function migratePersisted(persisted: unknown, version: number): PersistedState {
  if (version < 1) return { rounds: {}, lastLang: null, onboarded: false, solvedDays: {} };
  const p = persisted as Partial<PersistedState>;
  const rounds = p.rounds ?? {};
  const lastLang = p.lastLang ?? null;
  const onboarded =
    typeof p.onboarded === 'boolean'
      ? p.onboarded
      : Object.keys(rounds).length > 0 || lastLang != null;
  const solvedDays = p.solvedDays ?? {};
  return { rounds, lastLang, onboarded, solvedDays };
}

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      rounds: {},
      lastLang: null,
      onboarded: false,
      solvedDays: {},
      activeKey: null,
      tutorialOpen: null,

      openTutorial: (kind) => set({ tutorialOpen: kind }),
      closeTutorial: () => set({ tutorialOpen: null }),

      setLastLang: (lang) => {
        if (!isLang(lang) || get().lastLang === lang) return;
        set({ lastLang: lang });
      },

      setOnboarded: () => {
        if (get().onboarded) return;
        set({ onboarded: true });
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

      recordGuess: (typed) =>
        set((s) => {
          const key = s.activeKey;
          if (!key) return {};
          const round = s.rounds[key];
          if (!round || round.tried.includes(typed)) return {}; // dedupe: unique tries only
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
      version: 3, // v3: + solvedDays (see migratePersisted for the upgrade path)
      migrate: migratePersisted,
      // Persist rounds, last language, the onboarding flag and the solved-day sets;
      // activeKey and the actions are transient. Each language's solved-day set is
      // capped to MAX_SOLVED_DAYS on write.
      partialize: (s): PersistedState => ({
        rounds: s.rounds,
        lastLang: s.lastLang,
        onboarded: s.onboarded,
        solvedDays: capAllSolvedDays(s.solvedDays),
      }),
    },
  ),
);
