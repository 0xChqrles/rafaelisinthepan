import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { RuntimeHole } from '@whippin/shared';
import { langFromPath } from '../langs';

// A round is identified by its `roundKey` = (server day, language). When that key
// changes (a new day flips, or a different language is picked) the persisted round
// is stale and gets discarded; the SAME key rehydrates the stored progress verbatim.
export interface RoundProgress {
  roundKey: string | null;
  holes: RuntimeHole[];
  // Score = number of unique valid tries.
  guessCount: number;
  // The deduped folded slugs already counted, kept as an array so the Set survives
  // JSON persistence.
  tried: string[];
}

interface GameState extends RoundProgress {
  // Selected language (App/Game read it). NOT persisted: the URL is its source of
  // truth on load — the store seeds it from the /<lang> path (see below), and App
  // keeps the address bar in sync. The round rehydrates once its language is active.
  lang: string | null;
  setLang: (lang: string | null) => void;

  // Reconcile the persisted round to `key`. A new key discards the stale round and
  // starts fresh from `initialHoles`; the same key is a no-op, so a reload keeps the
  // stored progress untouched (mid-round rehydration).
  ensureRound: (key: string, initialHoles: RuntimeHole[]) => void;

  // Count a valid guess. Deduped by folded slug: a repeat neither re-counts nor
  // re-appends. `typed` is already folded by the caller.
  recordGuess: (typed: string) => void;

  // A warm hit improved a hole: swap in its closer (accented) word + lower rank.
  improveHole: (index: number, word: string, rank: number) => void;
}

// Persistence is browser-only; in tests / SSR there is no localStorage, so fall back
// to a no-op store (no warnings, no persistence) instead of throwing.
const storage = createJSONStorage<RoundProgress>(() => {
  if (typeof window === 'undefined') {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
  return window.localStorage;
});

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      // Seed from the address bar so /fr and /en deep-link straight into the game
      // (a refresh or shared link skips the picker).
      lang: typeof window !== 'undefined' ? langFromPath(window.location.pathname) : null,
      roundKey: null,
      holes: [],
      guessCount: 0,
      tried: [],

      setLang: (lang) => set({ lang }),

      ensureRound: (key, initialHoles) => {
        if (get().roundKey === key) return; // same round -> keep persisted progress
        set({ roundKey: key, holes: initialHoles, guessCount: 0, tried: [] });
      },

      recordGuess: (typed) => {
        if (get().tried.includes(typed)) return; // dedupe: unique tries only
        set((s) => ({ tried: [...s.tried, typed], guessCount: s.guessCount + 1 }));
      },

      improveHole: (index, word, rank) =>
        set((s) => ({
          holes: s.holes.map((h, i) => (i === index ? { ...h, word, rank } : h)),
        })),
    }),
    {
      name: 'whippin-round',
      storage,
      // Persist only the round; the selected language and the actions are not stored.
      partialize: (s): RoundProgress => ({
        roundKey: s.roundKey,
        holes: s.holes,
        guessCount: s.guessCount,
        tried: s.tried,
      }),
    },
  ),
);
