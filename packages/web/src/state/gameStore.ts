import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RuntimeHole } from '@whippin/shared';
import { isLang } from '../langs';
import type { Layout } from '../game/keyboard';

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

interface PersistedState {
  // All rounds keyed by roundKey. Bounded to the current day's languages by ensureRound.
  rounds: Record<string, RoundProgress>;
  // Last-played language: seeds the `/` redirect so a return visit lands where you
  // last played (falls back to the browser language, then English).
  lastLang: string | null;
  // On-screen keyboard layout preference (issue #36). GLOBAL — independent of the
  // puzzle language and round: a French player on the EN puzzle keeps AZERTY. null =
  // never chosen, so the keyboard falls back to the language default (fr -> AZERTY);
  // once the player flips the layout this wins for every language/day.
  layout: Layout | null;
}

interface GameState extends PersistedState {
  // The round currently being played (its key). NOT persisted: ensureRound sets it each
  // load from the active puzzle's (day, lang). The mutating actions target rounds[activeKey].
  activeKey: string | null;

  // Remember the last-played language (drives the `/` redirect). Ignores non-languages.
  setLastLang: (lang: string) => void;

  // Set the global on-screen keyboard layout preference. Retained for older persisted
  // state even though the current keyboard no longer exposes a layout-switch key.
  setLayout: (layout: Layout) => void;

  // Reconcile the persisted rounds to `key`. A matching key rehydrates its stored
  // progress; a brand-new key starts fresh from `initialHoles`. Always prunes rounds
  // from other game days (a new day never keeps yesterday's), keeping the map bounded.
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
      layout: null,
      activeKey: null,

      setLastLang: (lang) => {
        if (!isLang(lang) || get().lastLang === lang) return;
        set({ lastLang: lang });
      },

      setLayout: (layout) => {
        if (get().layout === layout) return;
        set({ layout });
      },

      ensureRound: (key, initialHoles) =>
        set((s) => {
          // Prune rounds from other game days (and stale override rounds): a day key
          // keeps every same-day language (so switching language preserves the others),
          // an override/non-day key keeps only itself.
          const dayPrefix = dayPrefixOf(key);
          const kept: Record<string, RoundProgress> = {};
          for (const [k, v] of Object.entries(s.rounds)) {
            if (dayPrefix && k.startsWith(dayPrefix)) kept[k] = v;
          }
          // Same key -> rehydrate untouched; brand-new key -> fresh from initialHoles.
          kept[key] = s.rounds[key] ?? freshRound(initialHoles);
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
      // A pre-#36 v1 blob simply lacks `layout`; the default-state merge leaves it null.
      migrate: (persisted, version): PersistedState =>
        version < 1 ? { rounds: {}, lastLang: null, layout: null } : (persisted as PersistedState),
      // Persist the rounds, last language, and the global keyboard layout; activeKey and
      // the actions are transient.
      partialize: (s): PersistedState => ({ rounds: s.rounds, lastLang: s.lastLang, layout: s.layout }),
    },
  ),
);
