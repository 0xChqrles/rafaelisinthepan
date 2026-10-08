import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPuzzleCache } from './puzzleCache';
import { puzzleAddress, type Puzzle, type PuzzleRef } from '@whippin/shared';
import { puzzleUrl, puzzleOutcome, parsePuzzle } from '../api';

// Loads the puzzle `ref` names for the selected language: a game day (the caller decides
// which — the undated route's is `useHomeDay`'s, the active 22:00-ET day as of the player's
// last arrival; the archive (#55) names a past one) or a BONUS (shared bonus.ts), addressed
// by its id — the same one fetch, the same 404 -> noPuzzle path. The served puzzle is BY
// CONSTRUCTION the day it is persisted under. Idle (no fetch) until a language is chosen.
// The last few PARSED artifacts, kept across mounts (`puzzleCache.ts` holds the two bounds
// and the safety argument): going back and forth between today's result and an archive
// day no longer decompresses and parses megabytes on every arrival.
//
// `previewCode` is the operator's code for a day not yet out (shared preview.ts): it rides
// the fetch only. The cache stays keyed by the address — the code names no other puzzle.
const sentenceCache = createPuzzleCache<Puzzle>();

export default function usePuzzle(lang: string | null, ref: PuzzleRef, previewCode?: string) {
  const [error, setError] = useState<unknown | null>(null);
  const [noPuzzle, setNoPuzzle] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

  // The address it is fetched and cached by.
  const address = useMemo(() => puzzleAddress(ref), [ref]);
  const key = lang ? `${lang}:${address}` : null;

  // The puzzle is held WITH the key it answers, and a cached day is the first render's
  // own state: a revisit never shows the LOADING beat, and a day change never shows the
  // previous day's puzzle for the frame before the effect runs.
  const [held, setHeld] = useState<{ key: string; puzzle: Puzzle } | null>(() => {
    const hit = key ? sentenceCache.get(key) : null;
    return hit && key ? { key, puzzle: hit } : null;
  });
  const puzzle = held && held.key === key ? held.puzzle : null;

  useEffect(() => {
    setError(null);
    setNoPuzzle(false);
    if (!lang || !key) return undefined;
    const hit = sentenceCache.get(key);
    if (hit) {
      setHeld({ key, puzzle: hit });
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const answer = await sentenceCache.load(key, async () => {
          const res = await fetch(puzzleUrl(lang, address, previewCode));
          const outcome = puzzleOutcome(res.status);
          if (outcome === 'missing') return null;
          if (outcome === 'error') throw new Error(`HTTP ${res.status}`);
          return parsePuzzle(await res.json());
        });
        if (cancelled) return;
        if (answer === null) setNoPuzzle(true);
        else setHeld({ key, puzzle: answer });
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lang, key, address, previewCode, reloadTick]);

  const loading = lang != null && puzzle == null && error == null && !noPuzzle;

  return { puzzle, error, loading, noPuzzle, retry };
}
