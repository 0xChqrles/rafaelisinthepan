import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RuntimeHole } from '@whippin/shared';
import { isLang } from '../langs';

// A round is identified by its `roundKey` = (server day, language). The store keeps a
// MAP of rounds keyed by this string so progress in one language survives switching to
// another and back (the selector reads each language's status out of this map). The
// SAME key rehydrates its stored progress untouched; a NEW day prunes the previous
// day's rounds so a new day never bleeds yesterday's state in.
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

// The day-part prefix of a round key ("d:5:"), or null for a non-day key (the ?puzzle=
// override's "o:<nonce>:<lang>"). Drives pruning of rounds from other game days.
function dayPrefixOf(key: string): string | null {
  const m = /^(d:\d+:)/.exec(key);
  return m ? m[1] : null;
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
  // All rounds keyed by roundKey. Bounded to the current day's languages by ensureRound.
  rounds: Record<string, RoundProgress>;
  // Last-played language: seeds the `/` redirect so a return visit lands where you
  // last played (falls back to the browser language, then English).
  lastLang: string | null;
}

interface GameState extends PersistedState {
  // The round currently being played (its key). NOT persisted: ensureRound sets it each
  // load from the active puzzle's (day, lang). The mutating actions target rounds[activeKey].
  activeKey: string | null;

  // Remember the last-played language (drives the `/` redirect). Ignores non-languages.
  setLastLang: (lang: string) => void;

  // Reconcile the persisted rounds to `key`. A matching key with matching holes
  // rehydrates its stored progress; a brand-new key — or the same key whose puzzle was
  // re-published with a different sentence — starts fresh from `initialHoles`. Always
  // prunes rounds from other game days (a new day never keeps yesterday's), keeping the
  // map bounded.
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

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      rounds: {},
      lastLang: null,
      activeKey: null,

      setLastLang: (lang) => {
        if (!isLang(lang) || get().lastLang === lang) return;
        set({ lastLang: lang });
      },

      ensureRound: (key, initialHoles) =>
        set((s) => {
          // Prune rounds from other game days (and stale override rounds): a day key
          // keeps every same-day language (so switching language preserves the others),
          // an override/non-day key keeps every DAY round — a ?puzzle= test load must
          // never wipe the real day's progress — and prunes only other override rounds.
          const dayPrefix = dayPrefixOf(key);
          const kept: Record<string, RoundProgress> = {};
          for (const [k, v] of Object.entries(s.rounds)) {
            if (dayPrefix ? k.startsWith(dayPrefix) : dayPrefixOf(k) !== null) kept[k] = v;
          }
          // Same key + matching holes -> rehydrate untouched; a brand-new key OR a
          // re-published sentence under the same (day, lang) key (holes no longer match)
          // -> fresh from initialHoles, so stale holes never reach scoring.
          const existing = s.rounds[key];
          kept[key] =
            existing && holesMatchPuzzle(existing.holes, initialHoles)
              ? existing
              : freshRound(initialHoles);
          return { activeKey: key, rounds: kept };
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
      version: 1,
      // v0 was a single top-level round ({ roundKey, holes, ... }); the shape is now a
      // keyed map, so discard the old state rather than mis-merge it (one-time reset).
      // A v1 blob may still carry the RETIRED keyboard `layout` preference (removed with
      // the AZERTY layout) — pick only the current fields so it is silently dropped.
      migrate: (persisted, version): PersistedState => {
        if (version < 1) return { rounds: {}, lastLang: null };
        const p = persisted as PersistedState;
        return { rounds: p.rounds, lastLang: p.lastLang };
      },
      // Persist the rounds and last language; activeKey and the actions are transient.
      partialize: (s): PersistedState => ({ rounds: s.rounds, lastLang: s.lastLang }),
    },
  ),
);
