import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeProgress } from '../game/scoring';
import useVocab from '../hooks/useVocab';
import Phrase from '../components/Phrase';
import ProgressBar from '../components/ProgressBar';
import WordInput from '../components/WordInput';
import { fold } from '@word-hunt/shared';
import type { HitState, Hole, Puzzle, RankEntry, RankMap, RuntimeHole } from '@word-hunt/shared';

// Feedback shown under the input. Only INVALID words use it now (red shake +
// "does not exist"); a valid-but-too-far guess gives per-hole "MISS" feedback
// on the holes instead, so it needs no under-input message.
type Feedback = { text: string };

// When a guess impacts several holes, their UI effects (floating number + any
// word replacement) fire one after another, this many ms apart, instead of all
// at once.
const STAGGER_MS = 200;

// Wrapper: drives the single puzzle. Loads the language's fixed vocabulary
// (existence set) before playing — existence is decided by it, not by ranks.
export default function Game({ puzzle }: { puzzle: Puzzle }) {
  const { vocabSet, error } = useVocab(puzzle.lang);

  if (error !== null) return <p className="status error">FAILED TO LOAD VOCABULARY</p>;
  if (!vocabSet) return <p className="status">LOADING&hellip;</p>;

  // key remounts the round -> clean reset of holes and input.
  return (
    <Round
      words={puzzle.words}
      puzzleHoles={puzzle.holes}
      ranks={puzzle.ranks}
      vocabSet={vocabSet}
    />
  );
}

// One round: a sentence to discover. Ends when all holes are solved
// (progress reaches 100%).
function Round({
  words,
  puzzleHoles,
  ranks,
  vocabSet,
}: {
  words: string[];
  puzzleHoles: Hole[];
  ranks: RankMap;
  vocabSet: Set<string>;
}) {
  // State per hole: { pos, secret slug, displayed word, current rank, start rank }.
  const [holes, setHoles] = useState<RuntimeHole[]>(() =>
    puzzleHoles.map((h) => ({
      pos: h.pos,
      secret: h.secret.slug,
      word: h.start.word,
      rank: h.start_rank,
      startRank: h.start_rank,
    })),
  );

  const [input, setInput] = useState<string>('');
  // One transient floating indicator per hole the guess does NOT improve: a
  // distance number when warm, or "MISS" when too far (an improved hole shows its
  // exponent dropping instead). Each carries a unique id so it animates and clears
  // independently.
  const [hits, setHits] = useState<HitState[]>([]);
  const [invalidAt, setInvalidAt] = useState<number>(0); // timestamp signal -> input shake
  const [feedback, setFeedback] = useState<Feedback | null>(null); // message under the input
  // Score = number of unique tries. A try is a submitted word that exists in the
  // vocabulary, including misses; repeated folded guesses and non-existent words
  // are not counted.
  const [guessCount, setGuessCount] = useState<number>(0);
  const triedGuesses = useRef<Set<string>>(new Set());
  const hitId = useRef<number>(0); // monotonic id source for floating hits
  const pendingTimers = useRef<number[]>([]); // staggered effects still to fire

  // Clear any pending staggered effects when the round unmounts.
  useEffect(() => () => pendingTimers.current.forEach(clearTimeout), []);

  const solved = holes.every((h) => h.rank === 0); // sentence discovered -> round over

  // Reconstruction progress (0–100): how much of the sentence is rebuilt. Drives the
  // WIDTH of the top progress bar. Distinct from the guess-count performance number.
  const progress = useMemo<number>(() => computeProgress(holes, ranks), [holes, ranks]);

  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // Clear error feedback as soon as the player types again.
  const handleChange = useCallback((v: string) => {
    setInput(v);
    setFeedback(null);
  }, []);

  const submit = useCallback(
    (raw: string) => {
      if (solved) return;
      const typed = fold(raw);
      if (!typed) {
        setInput('');
        return;
      }

      // Existence is decided by the fixed vocabulary, NOT by the puzzle's ranks.
      if (!vocabSet.has(typed)) {
        // INVALID -> "does not exist": red shake + message under the input.
        setInvalidAt(Date.now());
        setFeedback({ text: 'this word does not exist' });
        setInput('');
        return;
      }

      setInput('');
      setFeedback(null);
      // Counted guess: a unique valid word (misses included). Repeated folded
      // guesses and non-existent words returned above do not increase the score.
      if (!triedGuesses.current.has(typed)) {
        triedGuesses.current.add(typed);
        setGuessCount((c) => c + 1);
      }

      // EVERY unsolved hole reacts to a valid guess (solved holes are locked out).
      // A hole is WARM when `typed` is in its top-K rank map (`entry` set) and TOO
      // FAR otherwise (`entry` undefined). Built in sentence order so the staggered
      // effects below fire left-to-right.
      const impacted = holes.flatMap((h, index) => {
        if (h.rank === 0) return [];
        const entry: RankEntry | undefined = ranks[h.secret][typed];
        return [{ index, entry }];
      });

      // Resolve each impacted hole's UI effect consecutively, STAGGER_MS apart,
      // in sentence order. Per hole it is EXACTLY ONE of: the word/rank replacement
      // (warm + improves -> the exponent drops), a floating distance number (warm,
      // no improvement), or a floating "MISS" (too far). One guess can advance or
      // solve several holes; they resolve one after another, not all at once. The
      // improvement test reads the hole state at submit time, which is safe because
      // each entry targets a distinct hole, so effect ordering can't change a decision.
      impacted.forEach(({ index, entry }, step) => {
        const apply = () => {
          const oldRank = holes[index].rank; // submit-time rank (start_rank on first improve)
          if (entry != null && entry.rank < oldRank) {
            // IMPROVEMENT: the exponent decreases. Swap in the entry's DISPLAY
            // form (accents kept) and lower rank — Hole plays the exponent-drop
            // animation on its own. No floating number here: the dropping
            // exponent IS the feedback.
            setHoles((prev) =>
              prev.map((h, i) => (i === index ? { ...h, word: entry.word, rank: entry.rank } : h)),
            );
          } else if (entry != null) {
            // WARM, NO IMPROVEMENT: nothing on the hole changes, so a transient
            // rank number floats on it as the only feedback.
            const id = (hitId.current += 1);
            setHits((prev) => [...prev, { holeIndex: index, value: entry.rank, id }]);
          } else {
            // TOO FAR: same floating animation as a hit, but it reads "MISS"
            // instead of a distance (no rank to show beyond top-K).
            const id = (hitId.current += 1);
            setHits((prev) => [...prev, { holeIndex: index, value: 0, id, miss: true }]);
          }
        };
        if (step === 0) {
          apply(); // first effect is immediate; the rest trail by STAGGER_MS each
          return;
        }
        const timer = window.setTimeout(() => {
          pendingTimers.current = pendingTimers.current.filter((t) => t !== timer);
          apply();
        }, step * STAGGER_MS);
        pendingTimers.current.push(timer);
      });
    },
    [holes, ranks, solved, vocabSet],
  );

  return (
    <div className="game">
      {/* Score: big faint try count behind the play area.
          Rendered inside .game's isolated stacking context so its z-index:-1 sits
          behind the content but above the page background. */}
      <div className="progress-background" aria-hidden="true">
        {guessCount}
      </div>

      {/* Reconstruction progress bar pinned to the top. WIDTH = the reconstruction
          value; COLOR follows reconstruction heat. */}
      <div className="hud">
        <ProgressBar value={progress} />
      </div>

      <Phrase words={words} holes={holes} hits={hits} onHitDone={removeHit} />

      <div className="input-area">
        {solved ? (
          // End of round: replace input with the verdict.
          <div className="round-end">
            <p className="round-end-label solved">SOLVED!</p>
            <p className="round-end-score">SCORE {guessCount}</p>
          </div>
        ) : (
          <>
            <WordInput
              value={input}
              onChange={handleChange}
              onSubmit={submit}
              invalidSignal={invalidAt}
            />
            <p className="hint">{feedback?.text || ' '}</p>
          </>
        )}
      </div>
    </div>
  );
}
