import { useEffect, useState } from 'react';

// The fixed vocabulary (existence set) for a language is immutable across puzzles
// and days, so fetch it at most once per session. Module-level cache shared by
// every mount; keyed by language.
const cache = new Map<string, Set<string>>();

// Existence set lives at public/vocab/<lang>.json (a JSON array of folded slugs),
// served from BASE_URL like the puzzle files.
function vocabPath(lang: string): string {
  return `${import.meta.env.BASE_URL}vocab/${lang}.json`;
}

// Loads (and caches) the fixed vocabulary Set for the chosen language. Idle until
// a language is given. Existence is decided by this Set, not by a puzzle's ranks.
export default function useVocab(lang: string | null) {
  const [vocabSet, setVocabSet] = useState<Set<string> | null>(
    () => (lang ? cache.get(lang) ?? null : null),
  );
  const [error, setError] = useState<unknown | null>(null);

  useEffect(() => {
    setError(null);
    if (!lang) {
      setVocabSet(null);
      return undefined;
    }
    const cached = cache.get(lang);
    if (cached) {
      setVocabSet(cached);
      return undefined;
    }

    setVocabSet(null);
    let cancelled = false;
    fetch(vocabPath(lang))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((arr: string[]) => {
        const set = new Set(arr);
        cache.set(lang, set);
        if (!cancelled) setVocabSet(set);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  return { vocabSet, error };
}
