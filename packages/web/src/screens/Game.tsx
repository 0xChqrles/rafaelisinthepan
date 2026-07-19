import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { computeProgress } from '../game/scoring';
import { progressTrajectory } from '../game/share';
import { canExtend } from '../game/keyboard';
import useVocab from '../hooks/useVocab';
import useToday from '../hooks/useToday';
import { useGameStore, roundKeyForDay, holesMatchPuzzle } from '../state/gameStore';
import Phrase from '../components/Phrase';
import ProgressBar from '../components/ProgressBar';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import SolvedScreen, { RESULTS_IN_MS } from '../components/SolvedScreen';
import StandingsLineup from '../components/StandingsLineup';
import LazyStreakDialog, { preloadStreakDialog } from '../components/LazyStreakDialog';
import SolvedCaption from '../components/SolvedCaption';
import LoadError from '../components/LoadError';
import { t, srHoleResult, srModelAhead, srModelLead } from '../i18n';
import { lineupModel, lineupEvents } from '../game/benchmark';
import { track } from '../analytics';
import { fold } from '@whippin/shared';
import type {
  BenchmarkResults,
  HitState,
  Hole,
  Puzzle,
  RankEntry,
  RankMap,
  RuntimeHole,
  Source,
} from '@whippin/shared';

// Feedback shown under the input. Only INVALID words use it now (red shake +
// "does not exist"); a valid-but-too-far guess gives per-hole "MISS" feedback
// on the holes instead, so it needs no under-input message.
type Feedback = { text: string };

// When a guess impacts several holes, effect starts are staggered this many ms apart.
// Floating distance/MISS feedback uses the same start stagger, then fades as one batch.
// Exported: the onboarding Tutorial (#51) replays the same choreography with the same
// numbers, so the scripted round feels exactly like the real one.
export const STAGGER_MS = 200;
export const FLOATING_HIT_INTRO_MS = 320;

// Shared with the tutorial's scripted timing. The real game no longer guesses when this
// finishes: each Hole reports its actual resolved animation completion to Round.
export const WORD_BLINK_MS = 600; // .word-replace-blink in index.css (0.2s steps(1) 3)
const STREAK_AFTER_WORDS_MS = 300;

// Wrapper: drives the single puzzle. Loads the language's fixed vocabulary
// (existence set + keyboard prefix set) before playing — existence is decided by it,
// not by ranks. The header lives ABOVE this (GameRoute), so Game renders only the game
// body (progress-bar row + play + tray) under the fixed header.
export default function Game({
  puzzle,
  dayNumber,
  isActiveDay = true,
  deferResultsAnimation = false,
}: {
  puzzle: Puzzle;
  dayNumber: number;
  // Whether this is the client's active day (false when replaying an archive day, #55):
  // gates the fresh-solve streak celebration and tags solve analytics as archive/live.
  isActiveDay?: boolean;
  // The dev streak preview lives above Game in App, so it supplies the same animation gate
  // as the real in-round dialog without coupling the preview to persisted round state.
  deferResultsAnimation?: boolean;
}) {
  const { vocab, error, retry } = useVocab(puzzle.lang);

  if (error !== null) {
    return <LoadError message={t(puzzle.lang, 'failedVocab')} lang={puzzle.lang} onRetry={retry} />;
  }
  if (!vocab) return <p className="status">{t(puzzle.lang, 'loading')}</p>;

  return (
    <Round
      words={puzzle.words}
      puzzleHoles={puzzle.holes}
      ranks={puzzle.ranks}
      source={puzzle.source}
      benchmark={puzzle.benchmark}
      vocabSet={vocab.vocabSet}
      prefixSet={vocab.prefixSet}
      lang={puzzle.lang}
      dayNumber={dayNumber}
      isActiveDay={isActiveDay}
      deferResultsAnimation={deferResultsAnimation}
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
  benchmark,
  vocabSet,
  prefixSet,
  lang,
  dayNumber,
  isActiveDay,
  deferResultsAnimation,
}: {
  words: string[];
  puzzleHoles: Hole[];
  ranks: RankMap;
  source?: Source;
  benchmark?: BenchmarkResults;
  vocabSet: Set<string>;
  prefixSet: Set<string>;
  lang: string;
  dayNumber: number;
  isActiveDay: boolean;
  deferResultsAnimation: boolean;
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

  // Identity of this round: the server day + language.
  const roundKey = useMemo(() => roundKeyForDay(dayNumber, lang), [dayNumber, lang]);

  const ensureRound = useGameStore((s) => s.ensureRound);
  const recordGuess = useGameStore((s) => s.recordGuess);
  const improveHole = useGameStore((s) => s.improveHole);
  const syncProgress = useGameStore((s) => s.syncProgress);
  const recordSolve = useGameStore((s) => s.recordSolve);

  // The client's active game day (local, DST-correct) — the streak's reference point. May
  // be dayNumber + 1 when an in-flight round is finished just past the 22:00 flip; the
  // store's recordSolve resolves that flip-edge case (and refuses archive replays).
  const todayDayNumber = useToday();

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

  // Hole owns the actual word-replacement animation, so it also owns the reliable finish
  // signal. Keep every resolved hole reported for this round; the round-key dependency on
  // the callback makes already-resolved rehydrated holes report again after navigation.
  const [resolvedHoleIndices, setResolvedHoleIndices] = useState<Set<number>>(() => new Set());
  useLayoutEffect(() => {
    setResolvedHoleIndices(new Set());
  }, [roundKey]);
  const markHoleResolved = useCallback((index: number) => {
    setResolvedHoleIndices((current) => {
      if (current.has(index)) return current;
      const next = new Set(current);
      next.add(index);
      return next;
    });
  }, [roundKey]);

  const [input, setInput] = useState<string>('');
  // A solving submit closes the prompt immediately, on the same render that launches
  // the final floating hits. The actual hole/store updates still finish on their existing
  // delayed choreography; this flag only owns the prompt's leftward fade and input lock.
  const [promptExiting, setPromptExiting] = useState(false);
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
  const resultFocusTimer = useRef<number | undefined>(undefined);

  // Screen-reader mirror of the visual guess feedback (floating numbers / "MISS" /
  // shakes are invisible to assistive tech): each submit composes one sentence into a
  // polite live region. The alternating zero-width suffix forces a DOM change even when
  // two consecutive guesses produce the identical text, so it is re-announced.
  const [announce, setAnnounce] = useState<string>('');
  const announceFlip = useRef<boolean>(false);
  const say = useCallback((text: string) => {
    announceFlip.current = !announceFlip.current;
    setAnnounce(text + (announceFlip.current ? '' : '​'));
  }, []);

  // Clear any pending staggered effects when the round unmounts.
  useEffect(
    () => () => {
      pendingTimers.current.forEach(clearTimeout);
      window.clearTimeout(resultFocusTimer.current);
    },
    [],
  );

  const solved = holes.every((h) => h.rank === 0); // sentence discovered -> round over
  const allWordsResolved = solved && resolvedHoleIndices.size === holes.length;

  // The celebration is deliberately code-split out of startup. Warm its chunk only while
  // an eligible unsolved daily round is idle; if a player solves before idle fires, the
  // just-solved transition below starts the same preload immediately. Both scheduling paths
  // are cleaned up with the round, and a speculative load failure remains retryable.
  useEffect(() => {
    if (solved || !isActiveDay) return undefined;
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => preloadStreakDialog(), { timeout: 4_000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(() => preloadStreakDialog(), 1_500);
    return () => window.clearTimeout(id);
  }, [dayNumber, isActiveDay, roundKey, solved]);

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

  // Gate the solved presentation on every Hole reporting its final displayed secret. The
  // playing UI stays up through the real animationend events, so slow/throttled frames and
  // a multi-hole final guess cannot let the streak cover words that are still resolving.
  // An already-solved round on load still reveals immediately.
  const [showResults, setShowResults] = useState<boolean>(solved);
  // The results component also mounts behind the streak screen. Fresh solves keep it at
  // frame zero until the source finishes; rehydrated solves start at the final frame.
  // A dev streak preview deliberately opts a rehydrated result back into the choreography.
  const [animateResults, setAnimateResults] = useState<boolean>(
    () => solved && deferResultsAnimation,
  );
  // Player progression gets a separate, one-time celebration. This is deliberately
  // transient rather than persisted: only the live unsolved -> solved transition may open
  // it, so refreshing or revisiting an already-solved round never interrupts the player.
  const [showStreakDialog, setShowStreakDialog] = useState(false);
  const [streakAdvanced, setStreakAdvanced] = useState(false);
  const [awaitingWordAnimations, setAwaitingWordAnimations] = useState(false);
  // Sentence metadata is its own reveal beat between player progression and the
  // sentence-specific metrics. Results may mount behind the streak, but their timers stay
  // frozen until the source typewriter explicitly reports that it has finished.
  const [sourceRevealStarted, setSourceRevealStarted] = useState(solved);
  const [sourceRevealComplete, setSourceRevealComplete] = useState(solved);
  const focusResultAfterSource = useRef(false);
  const prevSolved = useRef<boolean>(solved);
  useEffect(() => {
    const justSolved = solved && !prevSolved.current;
    prevSolved.current = solved;
    if (!solved) {
      setShowResults(false);
      setAnimateResults(false);
      setShowStreakDialog(false);
      setStreakAdvanced(false);
      setAwaitingWordAnimations(false);
      setPromptExiting(false);
      setSourceRevealStarted(false);
      setSourceRevealComplete(false);
      focusResultAfterSource.current = false;
      window.clearTimeout(resultFocusTimer.current);
      return undefined;
    }
    if (!justSolved) {
      setShowResults(true); // already solved on load (rehydrated) -> reveal without waiting
      setAnimateResults(deferResultsAnimation);
      setShowStreakDialog(false);
      setStreakAdvanced(false);
      setAwaitingWordAnimations(false);
      setPromptExiting(false);
      setSourceRevealStarted(true);
      setSourceRevealComplete(true);
      focusResultAfterSource.current = false;
      return undefined;
    }
    // The one analytics beat for "did the player finish a puzzle": fired ONLY on the
    // play-solve transition (never on the rehydration branch above). `archive`
    // distinguishes a replayed past day ('yes', #55) from the live daily puzzle ('no').
    track('solve', { lang, tries: guessCount, day: dayNumber, archive: isActiveDay ? 'no' : 'yes' });
    // Streak (#56): only an ACTIVE-DAY solve counts — archive replays must not touch the
    // streak. The gate lives HERE, not in the store: recordSolve's activeDay-1 tolerance
    // (the genuine flip-edge — an undated tab finished just past 22:00) is
    // INDISTINGUISHABLE from deliberately opening /<lang>/<yesterday>, since both have
    // solvedDay === activeDay - 1. Only the caller knows which route this is — the undated
    // active route keeps isActiveDay true across the flip, a dated past route is false —
    // so the flip-edge still records while an archive-yesterday solve does not.
    const didAdvanceStreak = isActiveDay && recordSolve(lang, dayNumber, todayDayNumber);
    setAnimateResults(true);
    setStreakAdvanced(didAdvanceStreak);
    if (didAdvanceStreak) preloadStreakDialog();
    setSourceRevealStarted(false);
    setSourceRevealComplete(false);
    setAwaitingWordAnimations(true);
    return undefined;
  }, [solved]);

  useEffect(() => {
    if (!awaitingWordAnimations || !allWordsResolved) return;
    // The archive and rehydration branches never open this dialog. recordSolve has
    // already updated the solved-day set synchronously — and its freshness tolerance is
    // mirrored here (solvedDay >= activeDay - 1), so a tab left open 2+ days can't
    // celebrate a solve the store just refused to record.
    const willShowStreak =
      streakAdvanced && isActiveDay && dayNumber >= todayDayNumber - 1;
    if (!willShowStreak) {
      setShowResults(true);
      setShowStreakDialog(false);
      setSourceRevealStarted(true);
      setAwaitingWordAnimations(false);
      return;
    }

    // Let the player see the fully resolved sentence for one clean beat before the
    // full-screen progression celebration begins. Mount results and the modal together so
    // the tries/squares choreography remains paused behind the streak until dismissal.
    const timer = window.setTimeout(() => {
      setShowResults(true);
      setShowStreakDialog(true);
      setAwaitingWordAnimations(false);
    }, STREAK_AFTER_WORDS_MS);
    return () => window.clearTimeout(timer);
  }, [
    allWordsResolved,
    awaitingWordAnimations,
    dayNumber,
    isActiveDay,
    streakAdvanced,
    todayDayNumber,
  ]);

  const dismissStreakDialog = useCallback(() => {
    // StreakDialog calls this only AFTER its 200ms exit fade. That callback is the source
    // typewriter's start line, so the citation can never appear underneath the fading
    // progression screen.
    setShowStreakDialog(false);
    focusResultAfterSource.current = true;
    setSourceRevealStarted(true);
  }, []);

  const finishSourceReveal = useCallback(() => {
    setSourceRevealComplete(true);
    if (!focusResultAfterSource.current) return;
    focusResultAfterSource.current = false;
    // This dialog has no trigger to restore focus to. Wait until the now-unblocked result
    // stack has risen in before focusing its next relevant sentence action.
    window.clearTimeout(resultFocusTimer.current);
    resultFocusTimer.current = window.setTimeout(
      () =>
        document.querySelector<HTMLButtonElement>('.result-action')?.focus({ preventScroll: true }),
      RESULTS_IN_MS,
    );
  }, []);

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
      if (promptExiting) return;
      setFeedback(null);
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [prefixSet, input, promptExiting],
  );

  const deleteChar = useCallback(() => {
    if (promptExiting) return;
    setFeedback(null);
    setInput((cur) => cur.slice(0, -1));
  }, [promptExiting]);

  // Replace the whole input (physical-keyboard history recall). Recalled values are
  // past valid words, hence valid prefixes, so no re-validation is needed.
  const replaceInput = useCallback((v: string) => {
    if (promptExiting) return;
    setFeedback(null);
    setInput(v);
  }, [promptExiting]);

  const submit = useCallback(
    (raw: string) => {
      if (solved || promptExiting) return;
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
        setFeedback({ text: t(lang, 'notAWord') });
        say(t(lang, 'notAWord'));
        return;
      }

      // Know at submit time whether this valid guess closes every remaining hole. Start
      // the prompt exit NOW — in the same React commit as the final hit indicators —
      // instead of waiting for the delayed store improvements to mark the round solved.
      const solvesAll = holes.every((h) => h.rank === 0 || ranks[h.secret][typed]?.rank === 0);
      setInput('');
      setFeedback(null);
      if (solvesAll) setPromptExiting(true);
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

      // Announce the guess's outcome to assistive tech — the audible twin of the
      // floating numbers below. One sentence covering every impacted hole (1-based, in
      // sentence order), plus the visible standings lineup's meaningful events (#81 —
      // the lineup itself is decorative): each opponent this counted try lets ahead,
      // by full label. The solved fanfare stays last when this guess finishes the round.
      const parts = impacted.map(({ index, entry }) =>
        srHoleResult(lang, index + 1, entry ? entry.rank : null),
      );
      if (benchmark && !history.includes(typed)) {
        const before = lineupModel(benchmark, guessCount, t(lang, 'you'));
        const after = lineupModel(benchmark, guessCount + 1, t(lang, 'you'));
        const { passedBy, lostLead } = lineupEvents(before, after);
        parts.push(
          ...passedBy.map((e) =>
            lostLead && e.key === after.entrants[0].key
              ? srModelLead(lang, e.label, e.tries as number)
              : srModelAhead(lang, e.label, e.tries as number),
          ),
        );
      }
      say(solvesAll ? [...parts, t(lang, 'srSolvedAll')].join(', ') : parts.join(', '));

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
    [
      holes,
      ranks,
      solved,
      promptExiting,
      vocabSet,
      recordGuess,
      improveHole,
      lang,
      say,
      benchmark,
      history,
      guessCount,
    ],
  );

  return (
    <div className="game">
      {/* Invisible live region: the screen-reader mirror of the per-hole visual
          feedback (see `say`). Polite, so it never interrupts the player's own typing
          echo mid-word. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* The header (flag / day id / archive + help) is rendered by GameRoute ABOVE this,
          so it stays put across the route's states. The progress bar gets its own
          FULL-WIDTH row just below that fixed header — nothing squeezes it on mobile.
          Bar WIDTH = the reconstruction value; COLOR follows progress. */}
      <div className="hud">
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
        <Phrase
          words={words}
          holes={holes}
          puzzleHoles={puzzleHoles}
          hits={hits}
          onHitDone={removeHit}
          onHoleResolved={markHoleResolved}
        />

        {/* Below the sentence: the prompt exits on the solving submit; after every final
            word settles (and, on the active day, after the streak closes), the source is
            typed into the same reserved footprint. Nothing shifts the sentence. */}
        {showResults ? (
          sourceRevealStarted ? (
            <SolvedCaption
              source={source}
              animate={!sourceRevealComplete}
              onComplete={finishSourceReveal}
            />
          ) : (
            <div className="solved-caption" aria-hidden="true" />
          )
        ) : (
          <div
            className={`input-area${promptExiting ? ' solving' : ''}`}
            aria-hidden={promptExiting || undefined}
          >
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

      {/* Standings lineup (#81): the player + the 3 benchmark opponents sorted by tries,
          crown on the leader, between the input area and the keyboard. Height comes out
          of .play's flexible space, never the keyboard's. It persists for the whole round
          (a scoreboard, not a chase); on the solving try the crown flips gold and the
          lineup freezes, leaving with the keyboard when the results take the tray. */}
      {benchmark && !showResults && (
        <StandingsLineup
          benchmark={benchmark}
          guessCount={guessCount}
          solved={solved}
          lang={lang}
        />
      )}

      {/* Bottom zone (fixed keyboard-height footprint): the on-screen keyboard while
          playing, the solved results in the SAME space once they reveal — so the keyboard
          leaving neither reflows the layout nor leaves an empty hole. The keyboard lingers
          (inert; submit is guarded) through the last hole's animation, then the results
          take its place and animate in. */}
      <div className="tray">
        {showResults ? (
          <SolvedScreen
            guessCount={guessCount}
            trajectory={trajectory}
            dayNumber={dayNumber}
            lang={lang}
            benchmark={benchmark}
            animate={animateResults}
            startAnimation={
              sourceRevealComplete && !showStreakDialog && !deferResultsAnimation
            }
          />
        ) : (
          <Keyboard
            input={input}
            prefixSet={prefixSet}
            vocabSet={vocabSet}
            lang={lang}
            onType={appendChar}
            onBackspace={deleteChar}
            onSubmit={submit}
          />
        )}
      </div>

      {showStreakDialog && (
        <LazyStreakDialog lang={lang} solvedDay={dayNumber} onDismiss={dismissStreakDialog} />
      )}
    </div>
  );
}
