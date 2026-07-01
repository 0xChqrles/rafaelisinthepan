import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeProgress } from '../game/scoring';
import useVocab from '../hooks/useVocab';
import { useGameStore } from '../state/gameStore';
import Phrase from '../components/Phrase';
import ProgressBar from '../components/ProgressBar';
import HomeButton from '../components/HomeButton';
import WordInput from '../components/WordInput';
import { fold } from '@whippin/shared';
import type { HitState, Hole, Puzzle, RankEntry, RankMap, RuntimeHole } from '@whippin/shared';

// Feedback shown under the input. Only INVALID words use it now (red shake +
// "does not exist"); a valid-but-too-far guess gives per-hole "MISS" feedback
// on the holes instead, so it needs no under-input message.
type Feedback = { text: string };

// When a guess impacts several holes, effect starts are staggered this many ms apart.
// Floating distance/MISS feedback uses the same start stagger, then fades as one batch.
const STAGGER_MS = 200;
const FLOATING_HIT_INTRO_MS = 320;

// Per page-load token isolating a ?puzzle= override round (no server day to key on),
// so testing a static file always starts fresh and never rehydrates another file.
const OVERRIDE_NONCE = Math.random().toString(36).slice(2);

// Wrapper: drives the single puzzle. Loads the language's fixed vocabulary
// (existence set) before playing — existence is decided by it, not by ranks.
export default function Game({ puzzle, dayNumber }: { puzzle: Puzzle; dayNumber: number | null }) {
  const { vocabSet, error } = useVocab(puzzle.lang);

  if (error !== null) return <p className="status error">FAILED TO LOAD VOCABULARY</p>;
  if (!vocabSet) return <p className="status">LOADING&hellip;</p>;

  return (
    <Round
      words={puzzle.words}
      puzzleHoles={puzzle.holes}
      ranks={puzzle.ranks}
      vocabSet={vocabSet}
      lang={puzzle.lang}
      dayNumber={dayNumber}
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
  lang,
  dayNumber,
}: {
  words: string[];
  puzzleHoles: Hole[];
  ranks: RankMap;
  vocabSet: Set<string>;
  lang: string;
  dayNumber: number | null;
}) {
  // Fresh per-hole state derived from the puzzle. Used until the persisted store
  // reconciles to this round, and as the reset state on a new day/language.
  const freshHoles = useMemo<RuntimeHole[]>(
    () =>
      puzzleHoles.map((h) => ({
        pos: h.pos,
        secret: h.secret.slug,
        word: h.start.word,
        rank: h.start_rank,
        startRank: h.start_rank,
      })),
    [puzzleHoles],
  );

  // Identity of this round: the server day + language. A ?puzzle= override has no
  // server day, so a per-load nonce keeps it ephemeral (fresh every load).
  const roundKey = useMemo(
    () => (dayNumber != null ? `d:${dayNumber}:${lang}` : `o:${OVERRIDE_NONCE}:${lang}`),
    [dayNumber, lang],
  );

  const ensureRound = useGameStore((s) => s.ensureRound);
  const recordGuess = useGameStore((s) => s.recordGuess);
  const improveHole = useGameStore((s) => s.improveHole);
  const setLang = useGameStore((s) => s.setLang);

  // Reconcile before paint: a matching key rehydrates the stored progress, a new key
  // (new day OR new language) resets to freshHoles. useLayoutEffect commits the reset
  // before the browser paints, so a stale day's holes never flash.
  useLayoutEffect(() => {
    ensureRound(roundKey, freshHoles);
  }, [ensureRound, roundKey, freshHoles]);

  // Persisted round state: read from the store only once it matches THIS round; until
  // it does (the pre-reconcile frame) fall back to freshHoles / a zero score.
  const storeKey = useGameStore((s) => s.roundKey);
  const storeHoles = useGameStore((s) => s.holes);
  const storeGuessCount = useGameStore((s) => s.guessCount);
  const active = storeKey === roundKey;
  const holes = active ? storeHoles : freshHoles;
  // Score = number of unique tries. A try is a submitted word that exists in the
  // vocabulary, including misses; repeated folded guesses and non-existent words are
  // not counted (deduping happens in the store's recordGuess).
  const guessCount = active ? storeGuessCount : 0;

  const [input, setInput] = useState<string>('');
  // One transient floating indicator per impacted hole: a distance number when
  // warm, or "MISS" when too far. An improving hole shows the distance too; its
  // exponent drops as the number fades, then the old word blinks out and the
  // closer word takes its place (the staging lives in Hole). Each carries a unique
  // id so it animates and clears independently. These are ephemeral UI, not persisted.
  const [hits, setHits] = useState<HitState[]>([]);
  const [invalidAt, setInvalidAt] = useState<number>(0); // timestamp signal -> input shake
  const [feedback, setFeedback] = useState<Feedback | null>(null); // message under the input
  const hitId = useRef<number>(0); // monotonic id source for floating hits
  const pendingTimers = useRef<number[]>([]); // deferred word/rank swaps (fire as the hit fades)

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
      // Counted guess: a unique valid word (misses included). The store dedupes by
      // folded slug, so repeats and the non-existent words returned above never
      // increase the score.
      recordGuess(typed);

      // EVERY unsolved hole reacts to a valid guess (solved holes are locked out).
      // A hole is WARM when `typed` is in its top-K rank map (`entry` set) and TOO
      // FAR otherwise (`entry` undefined). Built in sentence order so the floating
      // feedback below staggers left-to-right.
      const impacted = holes.flatMap((h, index) => {
        if (h.rank === 0) return [];
        const entry: RankEntry | undefined = ranks[h.secret][typed];
        return [{ index, entry }];
      });

      // Every impacted hole shows a floating indicator: the distance number when
      // warm, or "MISS" when too far. They start in sentence-order sequence
      // (STAGGER_MS apart) and fade out together as one batch. A hole the guess
      // IMPROVES shows the distance too; the entry's closer word + lower rank are
      // handed over as its number begins to fade, and Hole stages the rest (drop
      // the exponent during the fade, then blink out the old word and reveal the
      // new one).
      const fadeDelayMs = Math.max(0, impacted.length - 1) * STAGGER_MS + FLOATING_HIT_INTRO_MS;
      impacted.forEach(({ index, entry }, step) => {
        const oldRank = holes[index].rank; // submit-time rank (start_rank on first improve)
        const improves = entry != null && entry.rank < oldRank;
        const startDelayMs = step * STAGGER_MS;

        const id = (hitId.current += 1);
        setHits((prev) => [
          ...prev,
          entry != null
            ? { holeIndex: index, value: entry.rank, id, startDelayMs, fadeDelayMs }
            : { holeIndex: index, value: 0, id, startDelayMs, fadeDelayMs, miss: true },
        ]);

        if (!improves || entry == null) return;

        // IMPROVEMENT: hand the entry's DISPLAY form (accents kept) and lower rank
        // to the hole as its floating hit starts fading out — Hole drops the
        // exponent during the fade, then blinks the old word out and reveals this
        // new one.
        const { word, rank } = entry;
        const timer = window.setTimeout(() => {
          pendingTimers.current = pendingTimers.current.filter((t) => t !== timer);
          improveHole(index, word, rank);
        }, fadeDelayMs);
        pendingTimers.current.push(timer);
      });
    },
    [holes, ranks, solved, vocabSet, recordGuess, improveHole],
  );

  return (
    <div className="game">
      {/* Score: big faint try count behind the play area.
          Rendered inside .game's isolated stacking context so its z-index:-1 sits
          behind the content but above the page background. */}
      <div className="progress-background" aria-hidden="true">
        {guessCount}
      </div>

      {/* Header row pinned to the top: the logo (home) beside the reconstruction
          progress bar. Bar WIDTH = the reconstruction value; COLOR follows heat. */}
      <div className="hud">
        <HomeButton onClick={() => setLang(null)} />
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
