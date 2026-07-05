import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeProgress } from '../game/scoring';
import { progressTrajectory } from '../game/share';
import { canExtend } from '../game/keyboard';
import useVocab from '../hooks/useVocab';
import { useGameStore, roundKeyForDay, holesMatchPuzzle } from '../state/gameStore';
import Phrase from '../components/Phrase';
import ProgressBar from '../components/ProgressBar';
import FlagButton from '../components/FlagButton';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import SolvedScreen from '../components/SolvedScreen';
import SolvedCaption from '../components/SolvedCaption';
import LoadError from '../components/LoadError';
import { HIT_FADE_MS } from '../components/FloatingHit';
import { fold } from '@whippin/shared';
import type { HitState, Hole, Puzzle, RankEntry, RankMap, RuntimeHole, Source } from '@whippin/shared';

// Feedback shown under the input. Only INVALID words use it now (red shake +
// "does not exist"); a valid-but-too-far guess gives per-hole "MISS" feedback
// on the holes instead, so it needs no under-input message.
type Feedback = { text: string };

// When a guess impacts several holes, effect starts are staggered this many ms apart.
// Floating distance/MISS feedback uses the same start stagger, then fades as one batch.
const STAGGER_MS = 200;
const FLOATING_HIT_INTRO_MS = 320;

// Once the last hole is solved it still animates: the exponent rolls to 0 (HIT_FADE_MS),
// then the secret word blinks into place (.word-replace-blink = 0.2s x 3). Hold the
// playing UI until that finishes, then transition to the solved presentation — so the
// results never pop in over a still-resolving word. Kept in sync with those two effects.
const WORD_BLINK_MS = 600; // .word-replace-blink in index.css (0.2s steps(1) 3)
const LAST_HOLE_SETTLE_MS = HIT_FADE_MS + WORD_BLINK_MS;

// Per page-load token isolating a ?puzzle= override round (no server day to key on),
// so testing a static file always starts fresh and never rehydrates another file.
const OVERRIDE_NONCE = Math.random().toString(36).slice(2);

// Wrapper: drives the single puzzle. Loads the language's fixed vocabulary
// (existence set + keyboard prefix set) before playing — existence is decided by it,
// not by ranks.
export default function Game({ puzzle, dayNumber }: { puzzle: Puzzle; dayNumber: number | null }) {
  const { vocab, error, retry } = useVocab(puzzle.lang);

  if (error !== null) return <LoadError message="FAILED TO LOAD VOCABULARY" onRetry={retry} />;
  if (!vocab) return <p className="status">LOADING&hellip;</p>;

  return (
    <Round
      words={puzzle.words}
      puzzleHoles={puzzle.holes}
      ranks={puzzle.ranks}
      source={puzzle.source}
      vocabSet={vocab.vocabSet}
      prefixSet={vocab.prefixSet}
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
  source,
  vocabSet,
  prefixSet,
  lang,
  dayNumber,
}: {
  words: string[];
  puzzleHoles: Hole[];
  ranks: RankMap;
  source?: Source;
  vocabSet: Set<string>;
  prefixSet: Set<string>;
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
    () => (dayNumber != null ? roundKeyForDay(dayNumber, lang) : `o:${OVERRIDE_NONCE}:${lang}`),
    [dayNumber, lang],
  );

  const ensureRound = useGameStore((s) => s.ensureRound);
  const recordGuess = useGameStore((s) => s.recordGuess);
  const improveHole = useGameStore((s) => s.improveHole);
  const syncProgress = useGameStore((s) => s.syncProgress);

  // Reconcile before paint: a matching key rehydrates the stored progress, a new key
  // (new day OR new language) resets to freshHoles. useLayoutEffect commits the reset
  // before the browser paints, so a stale day's holes never flash.
  useLayoutEffect(() => {
    ensureRound(roundKey, freshHoles);
  }, [ensureRound, roundKey, freshHoles]);

  // Persisted round state for THIS round, read straight out of the keyed map. Use it
  // only when its holes still match THIS puzzle: a re-published sentence keeps the
  // (day, lang) key but changes the holes, and those stale holes carry secrets absent
  // from `ranks` (scoring would crash). On that frame — as on the pre-reconcile frame
  // before ensureRound resets the store — fall back to freshHoles / zero.
  const round = useGameStore((s) => s.rounds[roundKey]);
  const live = round && holesMatchPuzzle(round.holes, freshHoles) ? round : undefined;
  const holes = live ? live.holes : freshHoles;
  // Score = number of unique tries. A try is a submitted word that exists in the
  // vocabulary, including misses; repeated folded guesses and non-existent words are
  // not counted (deduping happens in the store's recordGuess).
  const guessCount = live ? live.guessCount : 0;
  // Prompt history for Up/Down recall = this round's unique valid guesses in order.
  // Sourced from the persisted `tried` list, so recall survives a reload (per day+lang).
  const history = live ? live.tried : [];

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

  // Per-guess reconstruction-% trajectory for the solved screen's share grid: replay
  // this round's ordered valid guesses, one value per counted try. Derived from the
  // persisted `tried` list, so it survives a reload just like the score.
  const trajectory = useMemo<number[]>(
    () => progressTrajectory(freshHoles, ranks, history),
    [freshHoles, ranks, history],
  );

  // Gate the solved presentation on the last hole's solve animation finishing (see
  // LAST_HOLE_SETTLE_MS): the playing UI (input + keyboard) stays up until then, so the
  // sentence resolves in place and the results reveal cleanly afterwards — no reflow, no
  // pop-over. An already-solved round on load has no animation to wait for.
  const [showResults, setShowResults] = useState<boolean>(solved);
  const prevSolved = useRef<boolean>(solved);
  useEffect(() => {
    const justSolved = solved && !prevSolved.current;
    prevSolved.current = solved;
    if (!solved) {
      setShowResults(false);
      return undefined;
    }
    if (!justSolved) {
      setShowResults(true); // already solved on load (rehydrated) -> reveal without waiting
      return undefined;
    }
    const t = window.setTimeout(() => setShowResults(true), LAST_HOLE_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [solved]);

  // Cache the progress on the persisted round so the language selector can badge an
  // in-progress language without re-loading its rank map. No-op when unchanged.
  useEffect(() => {
    syncProgress(progress);
  }, [progress, syncProgress]);

  const removeHit = useCallback((id: number) => {
    setHits((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // Input mutations shared by the on-screen keyboard (taps) and the physical keyboard.
  // Every path clears the "does not exist" feedback as soon as the player edits again.

  // Append one slug char, but ONLY if it keeps the input a prefix of some real word
  // (the same rule that greys the on-screen key). A dead-end char shakes the prompt
  // instead of being silently dropped: the on-screen keys grey out and shake in place,
  // but physical typing has no key to look at — without feedback a swallowed letter
  // reads as broken input. Shake only, no "does not exist" message (that one is about
  // a submitted word).
  const appendChar = useCallback(
    (char: string) => {
      setFeedback(null);
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [prefixSet, input],
  );

  const deleteChar = useCallback(() => {
    setFeedback(null);
    setInput((cur) => cur.slice(0, -1));
  }, []);

  // Replace the whole input (physical-keyboard history recall). Recalled values are
  // past valid words, hence valid prefixes, so no re-validation is needed.
  const replaceInput = useCallback((v: string) => {
    setFeedback(null);
    setInput(v);
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
        // INVALID -> "does not exist": red shake + message under the input. Keep the
        // typed word (do NOT clear) so the player can correct it; the next edit clears
        // the message.
        setInvalidAt(Date.now());
        setFeedback({ text: 'this word does not exist' });
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
      {/* Header row pinned to the top: the current puzzle's language flag (opens the
          selector) beside the reconstruction progress bar. Bar WIDTH = the
          reconstruction value; COLOR follows heat. */}
      <div className="hud">
        <FlagButton lang={lang} />
        <ProgressBar value={progress} />
      </div>

      {/* The play area fills the space between the fixed HUD (top) and the keyboard
          (bottom) and centers its content, so the sentence + prompt sit in the middle.
          It also anchors the score watermark, so the big try count stays centered
          behind THIS content rather than the full-height .game. */}
      <div className="play">
        {/* Score: big faint try count behind the play area. z-index:-1 within .play's
            isolated stacking context sits behind the content but above the page. */}
        <div className="progress-background" aria-hidden="true">
          {guessCount}
        </div>

        {/* The reconstructed sentence stays visible in BOTH states: while playing (with
            the live holes/hits) and once solved (every hole resolved to its accented
            secret) — it is the "full reconstructed sentence" of the solved screen. */}
        <Phrase words={words} holes={holes} puzzleHoles={puzzleHoles} hits={hits} onHitDone={removeHit} />

        {/* Below the sentence: the input while playing, its attribution once the results
            reveal. Both reserve the same height, so the transition never shifts the
            sentence up. The swap waits for the last hole to finish animating (showResults),
            so the input stays put while the final word resolves. */}
        {showResults ? (
          <SolvedCaption source={source} />
        ) : (
          <div className="input-area">
            <WordInput
              value={input}
              history={history}
              onType={appendChar}
              onBackspace={deleteChar}
              onSubmit={submit}
              onReplace={replaceInput}
              invalidSignal={invalidAt}
            />
            <p className="hint">{feedback?.text || ' '}</p>
          </div>
        )}
      </div>

      {/* Bottom zone (fixed keyboard-height footprint): the on-screen keyboard while
          playing, the solved results in the SAME space once they reveal — so the keyboard
          leaving neither reflows the layout nor leaves an empty hole. The keyboard lingers
          (inert; submit is guarded) through the last hole's animation, then the results
          take its place and animate in. */}
      <div className="tray">
        {showResults ? (
          <SolvedScreen guessCount={guessCount} trajectory={trajectory} dayNumber={dayNumber} lang={lang} />
        ) : (
          <Keyboard
            input={input}
            prefixSet={prefixSet}
            vocabSet={vocabSet}
            onType={appendChar}
            onBackspace={deleteChar}
            onSubmit={submit}
          />
        )}
      </div>
    </div>
  );
}
