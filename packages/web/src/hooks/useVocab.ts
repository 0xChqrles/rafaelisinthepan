import { useCallback, useEffect, useState } from 'react';
import { buildPrefixSet } from '../game/keyboard';

// The fixed vocabulary (existence set) for a language is immutable across puzzles
// and days, so load it at most once per session. Alongside the existence Set we keep
// the prefix Set (every prefix of every word, issue #36) the on-screen keyboard uses
// to grey out dead-end letters. Both are derived once and cached together per language.
interface Vocab {
  // Exact membership: fold(input) exists as a word. Decides validity on submit.
  vocabSet: Set<string>;
  // Every prefix of every word: (input + letter) membership answers "can this letter
  // still lead to a real word?" — the greyed-out state of the on-screen keys.
  prefixSet: Set<string>;
}

// Module-level cache shared by every mount; keyed by language.
const cache = new Map<string, Vocab>();

// Existence set lives at public/vocab/<lang>.json (a JSON array of folded slugs),
// served from BASE_URL like the puzzle files.
function vocabPath(lang: string): string {
  return `${import.meta.env.BASE_URL}vocab/${lang}.json`;
}

// Loads (and caches) the fixed vocabulary for the chosen language: the existence Set
// plus the derived prefix Set. Idle until a language is given. Existence is decided by
// vocabSet, not by a puzzle's ranks.
export default function useVocab(lang: string | null) {
  const [vocab, setVocab] = useState<Vocab | null>(
    () => (lang ? cache.get(lang) ?? null : null),
  );
  const [error, setError] = useState<unknown | null>(null);
  // Bumped by retry() to re-run the fetch after a transient/unexpected failure — kept
  // consistent with usePuzzle so vocab errors offer the same retry (issue #14). A
  // failed load caches nothing, so retry simply re-fetches.
  const [reloadTick, setReloadTick] = useState(0);
  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    setError(null);
    if (!lang) {
      setVocab(null);
      return undefined;
    }
    const cached = cache.get(lang);
    if (cached) {
      setVocab(cached);
      return undefined;
    }

    setVocab(null);
    let cancelled = false;
    fetch(vocabPath(lang))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: unknown) => {
        // Guard the shape: a truncated/wrong body is valid JSON but not a string[] —
        // catch it here so it surfaces as the error state, not a later crash.
        if (!Array.isArray(data) || !data.every((w) => typeof w === 'string')) {
          throw new Error('malformed vocab: expected an array of strings');
        }
        // Build both Sets in one pass at load. buildPrefixSet is a single linear
        // scan; measured on the ~400k-word vocabs it stays well under the load screen.
        const vocabSet = new Set(data);
        const prefixSet = buildPrefixSet(data);
        const value: Vocab = { vocabSet, prefixSet };
        cache.set(lang, value);
        if (!cancelled) setVocab(value);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [lang, reloadTick]);

  return { vocab, error, retry };
}
