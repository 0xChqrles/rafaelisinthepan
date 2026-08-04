import { useCallback, useEffect, useMemo, useState } from 'react';
import { activeDate, dayNumber as dayNumberOf, type WordPuzzle } from '@whippin/shared';
import { wordPuzzleUrl, puzzleOutcome, parseWordPuzzle } from '../api';

// Word mode's twin of usePuzzle (#156): loads the day's #154 single-word artifact for
// the selected language. Same one-fetch, date-addressed protocol — the requested day is
// captured once (the archive's explicit past `date`, else the active 22:00-ET day at
// mount), the 404 -> noPuzzle path is shared, and `dayNumber` keys the word round the
// same way usePuzzle's keys the sentence round. Idle (no fetch) until a language is
// chosen.
export default function useWordPuzzle(lang: string | null, date?: string) {
  const [puzzle, setPuzzle] = useState<WordPuzzle | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [noPuzzle, setNoPuzzle] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

  const requestedDate = useMemo(() => date ?? activeDate(new Date()), [date]);
  const dayNumber = useMemo(() => dayNumberOf(requestedDate), [requestedDate]);

  useEffect(() => {
    setPuzzle(null);
    setError(null);
    setNoPuzzle(false);
    if (!lang) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(wordPuzzleUrl(lang, requestedDate));
        const outcome = puzzleOutcome(res.status);
        if (outcome === 'missing') {
          if (!cancelled) setNoPuzzle(true);
          return;
        }
        if (outcome === 'error') throw new Error(`HTTP ${res.status}`);
        const json = parseWordPuzzle(await res.json());
        if (!cancelled) setPuzzle(json);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lang, requestedDate, reloadTick]);

  const loading = lang != null && puzzle == null && error == null && !noPuzzle;

  return { puzzle, dayNumber, error, loading, noPuzzle, retry };
}
