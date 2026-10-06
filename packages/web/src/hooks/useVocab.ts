import { useCallback, useEffect, useRef, useState } from 'react';
import { buildPrefixSet } from '../game/keyboard';

// The fixed vocabulary (existence set) for a language is immutable across puzzles
// and days, so load it at most once per session. Alongside the existence Set we keep
// the prefix Set (every prefix of every word, issue #36) the on-screen keyboard uses
// to grey out dead-end letters. Both are derived once and cached together per language.
export interface Vocab {
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
// plus the derived prefix Set. Idle until a language is given — and a language taken BACK
// (`null` while its read is out: the game route learning that the day has no puzzle) stops
// that read where it stands, since a word list is a big download with nothing to play it on.
// A read left by an unmount runs on and lands in the cache. Existence is decided by
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
  // The read out for this hook, until it lands or fails.
  const reading = useRef<AbortController | null>(null);

  useEffect(() => {
    setError(null);
    if (!lang) {
      reading.current?.abort();
      reading.current = null;
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
    const controller = new AbortController();
    reading.current = controller;
    fetch(vocabPath(lang), { signal: controller.signal })
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
      })
      .finally(() => {
        if (reading.current === controller) reading.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [lang, reloadTick]);

  return { vocab, error, retry };
}
