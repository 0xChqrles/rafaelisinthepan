import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { fold, type WordPuzzle } from '@whippin/shared';
import useVocab from '../hooks/useVocab';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import {
  STRIKES_TO_END,
  judgeWordGuess,
  replayWordRun,
  wordGuessKey,
} from '../game/wordGame';
import { buildWordBoard } from '../game/wordBoard';
import { canExtend } from '../game/keyboard';
import useScrollEdges from '../hooks/useScrollEdges';
import WordBoard from '../components/WordBoard';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import WordEndScreen from '../components/WordEndScreen';
import LoadError from '../components/LoadError';
import { t, srWordClaim, srWordFailures, srWordStrike } from '../i18n';
import { failIconUrl, preloadFailIcons } from '../components/failIcon';

// Word mode (#156): the second daily game on the same mechanic, inverted — the word is
// SHOWN and the player names its neighborhood. One claim per zone group, the run ends
// after STRIKES_TO_END consecutive incorrect guesses, and the score is the claim count.
// The board (components/WordBoard) is the primary play surface — the route-map concept,
// live; this screen owns the guess loop, the persisted round, and the tray.

// The auto-scroll onto a landed guess's station (see the effect below). The band is
// narrow ON PURPOSE: a hop to the next rank and a jump across the whole field should feel
// like the same gesture, and the far jump is exactly the one the browser's own smooth
// scroll spent close to a second on. At 6px/ms the widest board still lands inside
// SCROLL_MAX_MS, which sits with the app's other transitions (the modals' 120ms, the
// keyboard drop's 200, the results' 250) rather than above them.
const SCROLL_MIN_MS = 140;
const SCROLL_MAX_MS = 320;
const SCROLL_PX_PER_MS = 6;
// Let the final strike/reveal settle for one board-scroll beat before the keyboard leaves.
// The exit itself is the shared `.kb-drop`; this is only the clean look at what just landed.
const WORD_END_SETTLE_MS = SCROLL_MAX_MS;
// Like Sentence mode's fallback: a lost animationend must not strand an empty result tray.
const KB_EXIT_FALLBACK_MS = 1_200;
// Ease OUT only: the move starts at full speed (it is a reaction to the guess just
// submitted) and settles onto the station.
const easeOutScroll = (t: number) => 1 - (1 - t) ** 3;

function FailIcon({ filled }: { filled: boolean }) {
  const [, refresh] = useState(0);
  const state = filled ? 'filled' : 'empty';

  useEffect(() => {
    let active = true;
    void preloadFailIcons().then(() => {
      if (active) refresh((value) => value + 1);
    });
    return () => {
      active = false;
    };
  }, []);

  const src = failIconUrl(state);
  return (
    <span className="strike-pip" aria-hidden="true">
      {src && <img src={src} alt="" />}
    </span>
  );
}

function WordScore({ value }: { value: number }) {
  return (
    <span className="word-count" aria-hidden="true">
      {String(value)
        .split('')
        .map((digit, index) => {
          // digits.png is ordered 1..9,0, with one 7px slot per digit.
          const slot = digit === '0' ? 9 : Number(digit) - 1;
          return (
            <span
              key={`${digit}-${index}`}
              className="word-digit"
              style={{ '--digit-x': `${-slot * 28}px` } as CSSProperties}
            />
          );
        })}
    </span>
  );
}

function WordHeaderStatus({
  lang,
  score,
}: {
  lang: string;
  score: number;
}) {
  return (
    <span className="word-hud">
      <WordScore value={score} />
      <span className="sr-only">
        {`${score} ${t(lang, score === 1 ? 'word' : 'words')}`}
      </span>
    </span>
  );
}

function WordFailures({ lang, strikes }: { lang: string; strikes: number }) {
  return (
    <div
      className="word-strikes"
      role="img"
      aria-label={srWordFailures(lang, strikes, STRIKES_TO_END)}
    >
      {Array.from({ length: STRIKES_TO_END }, (_, i) => (
        <FailIcon key={i} filled={i < strikes} />
      ))}
    </div>
  );
}

export default function WordGame({
  puzzle,
  dayNumber,
  onHeaderLeftChange,
}: {
  puzzle: WordPuzzle;
  dayNumber: number;
  onHeaderLeftChange: (left: ReactNode | null) => void;
}) {
  const { vocab, error, retry } = useVocab(puzzle.lang);

  if (error !== null) {
    return <LoadError message={t(puzzle.lang, 'failedVocab')} lang={puzzle.lang} onRetry={retry} />;
  }
  if (!vocab) return <p className="status">{t(puzzle.lang, 'loading')}</p>;

  return (
    <WordRound
      key={`${dayNumber}:${puzzle.lang}:${puzzle.word.slug}`}
      puzzle={puzzle}
      vocabSet={vocab.vocabSet}
      prefixSet={vocab.prefixSet}
      dayNumber={dayNumber}
      onHeaderLeftChange={onHeaderLeftChange}
    />
  );
}

function WordRound({
  puzzle,
  vocabSet,
  prefixSet,
  dayNumber,
  onHeaderLeftChange,
}: {
  puzzle: WordPuzzle;
  vocabSet: Set<string>;
  prefixSet: Set<string>;
  dayNumber: number;
  onHeaderLeftChange: (left: ReactNode | null) => void;
}) {
  const lang = puzzle.lang;
  const ranks = puzzle.ranks;

  // Identity of this round: (server day, language, MODE) — the word round can never
  // collide with the same day's sentence round (#156).
  const roundKey = useMemo(() => roundKeyForDay(dayNumber, lang, 'word'), [dayNumber, lang]);
  const ensureWordRound = useGameStore((s) => s.ensureWordRound);
  const recordWordGuess = useGameStore((s) => s.recordWordGuess);

  // Reconcile before paint, like the sentence round: a matching key playing the same
  // word rehydrates; a republished different word resets.
  useLayoutEffect(() => {
    ensureWordRound(roundKey, puzzle.word.slug);
  }, [ensureWordRound, roundKey, puzzle.word.slug]);

  const round = useGameStore((s) => s.wordRounds[roundKey]);
  const live = round && round.word === puzzle.word.slug ? round : undefined;
  const tried = live ? live.tried : [];

  // The whole run replayed from the counted log — claims, strikes, ended. Pure, so a
  // reload reproduces the board exactly (the same contract as the sentence replay).
  const run = useMemo(() => replayWordRun(ranks, tried), [ranks, tried]);
  const score = run.claimedRanks.length;
  const ended = run.ended;

  // End presentation is transient, not persisted. A live run shows its final strike and
  // revealed board, drops the keyboard, then raises the results. A rehydrated ended run
  // initializes directly at the final frame.
  const [promptExiting, setPromptExiting] = useState(false);
  const [keyboardLeaving, setKeyboardLeaving] = useState(false);
  const [showResults, setShowResults] = useState(ended);
  const [animateResults, setAnimateResults] = useState(false);
  const previousEnded = useRef(ended);
  useEffect(() => {
    const justEnded = ended && !previousEnded.current;
    previousEnded.current = ended;
    if (!justEnded) return undefined;

    setPromptExiting(true);
    setAnimateResults(true);
    const id = window.setTimeout(() => setKeyboardLeaving(true), WORD_END_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [ended]);

  const finishKeyboardExit = useCallback(() => {
    setKeyboardLeaving(false);
    setShowResults(true);
  }, []);
  useEffect(() => {
    if (!keyboardLeaving) return undefined;
    const id = window.setTimeout(finishKeyboardExit, KB_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [finishKeyboardExit, keyboardLeaving]);

  const board = useMemo(
    () => buildWordBoard({ ranks, word: puzzle.word.word, tried }),
    [ranks, puzzle.word.word, tried],
  );

  // Keep the arcade standing inside the real app header. The status is absent when the
  // artifact has no drawable board, matching the load-failure body below.
  useLayoutEffect(() => {
    onHeaderLeftChange(board ? <WordHeaderStatus lang={lang} score={score} /> : null);
    return () => onHeaderLeftChange(null);
  }, [board, lang, onHeaderLeftChange, score]);

  const [input, setInput] = useState('');
  const [invalidAt, setInvalidAt] = useState(0);

  // Screen-reader mirror of the guess feedback (same pattern as the sentence round).
  const [announce, setAnnounce] = useState('');
  const announceFlip = useRef(false);
  const say = useCallback((text: string) => {
    announceFlip.current = !announceFlip.current;
    setAnnounce(text + (announceFlip.current ? '' : '​'));
  }, []);

  // The board scroller. It opens parked on the WORD at the bottom — the line is read
  // up from it, like the route map opens on its own end — and a counted guess scrolls
  // its station into view so the claim (or the near strike's boundary lesson) is seen
  // landing.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focusRank, setFocusRank] = useState<{ rank: number; at: number } | null>(null);
  // Which way the line still runs past the window's edges — the frame wears a torn dashed
  // rule on that side (the onboarding teaser's own vocabulary, shared with it in the hook).
  const { more, readEdges } = useScrollEdges(scrollRef);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    readEdges();
  }, [roundKey, readEdges]);
  // A claim adds rows and the run's end reveals the whole field, both of which change the
  // line's height under an unchanged scrollTop — no scroll event to catch it, exactly like
  // the resize the hook watches for.
  useLayoutEffect(() => {
    readEdges();
  }, [board, readEdges]);
  // Move onto the station a counted guess just landed on; once the run ends, the terminus
  // takes priority and the view returns to the true bottom of the routes. Driven here
  // rather than by `scrollIntoView({ behavior: 'smooth' })`, whose duration is the BROWSER's
  // and scales with the distance travelled: the field is ~150 rows, so a claim out at the
  // far edge crawled for the better part of a second before the player could see where it
  // landed — and the next guess is typeable the whole time. On this clock the move is over
  // in a beat, with the distance changing it only inside a narrow band.
  useLayoutEffect(() => {
    if (!ended && !focusRank) return undefined;
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const from = scroller.scrollTop;
    const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    let to = bottom;
    if (!ended && focusRank) {
      const station = scroller.querySelector<HTMLElement>(`[data-word-rank="${focusRank.rank}"]`);
      if (!station) return undefined;
      // Centre a live station in the window, clamped into the scroll range. Measured off
      // RECTS, never offsetTop: `.route-frame` is positioned, so IT is the offsetParent
      // rather than the scroller, and the two coordinate spaces differ (the route map's
      // own `offsetWithin` exists for exactly that trap). Nothing here is mid-transform,
      // so rects are honest. The ended branch deliberately skips this: the destination is
      // after every ranked station, at the route's actual bottom edge.
      const stationBox = station.getBoundingClientRect();
      const scrollerBox = scroller.getBoundingClientRect();
      to = Math.max(
        0,
        Math.min(
          from +
            stationBox.top +
            stationBox.height / 2 -
            (scrollerBox.top + scroller.clientHeight / 2),
          bottom,
        ),
      );
    }
    const distance = Math.abs(to - from);
    if (distance < 1) return undefined;
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      scroller.scrollTop = to;
      return undefined;
    }
    const duration = Math.min(
      SCROLL_MAX_MS,
      Math.max(SCROLL_MIN_MS, distance / SCROLL_PX_PER_MS),
    );
    let frame = 0;
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / duration);
      scroller.scrollTop = from + (to - from) * easeOutScroll(t);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    // A guess landing mid-move takes over from wherever the line has got to.
    return () => cancelAnimationFrame(frame);
  }, [ended, focusRank]);

  // Same prefix rule as the sentence game: a dead-end char shakes the prompt instead of
  // being silently dropped (physical typing has no greyed key to look at).
  const appendChar = useCallback(
    (char: string) => {
      if (ended) return;
      setInput((cur) => {
        if (canExtend(prefixSet, cur, char)) return cur + char;
        setInvalidAt(Date.now());
        return cur;
      });
    },
    [ended, prefixSet],
  );

  const deleteChar = useCallback(() => {
    if (ended) return;
    setInput((cur) => cur.slice(0, -1));
  }, [ended]);

  const replaceInput = useCallback(
    (v: string) => {
      if (ended) return;
      setInput(v);
    },
    [ended],
  );

  const submit = useCallback(
    (raw: string) => {
      if (ended) return;
      const typed = fold(raw);
      if (!typed) {
        setInput('');
        return;
      }

      // Existence is decided by the fixed vocabulary, never by the rank map. Invalid is
      // FREE: shake + message, no strike.
      if (!vocabSet.has(typed)) {
        setInvalidAt(Date.now());
        say(t(lang, 'notAWord'));
        return;
      }

      setInput('');

      // Repeats are FREE, deduped at GROUP level (#104): an inflection or accent alias
      // of an already-counted guess shares its group's rank, so it never re-counts —
      // and never enters the persisted log.
      const key = wordGuessKey(ranks, typed);
      if (tried.some((prev) => wordGuessKey(ranks, prev) === key)) {
        say(t(lang, 'wordRepeat'));
        return;
      }

      const judged = judgeWordGuess(ranks, typed);
      // The day's word itself is public — typing it is free, not a claim.
      if (judged.kind === 'zero') {
        say(t(lang, 'wordItself'));
        return;
      }

      // A COUNTED guess: append it and cache the replayed claim count / end state, so
      // the archive and selector can badge the day without this rank map.
      const nextRun = replayWordRun(ranks, [...tried, typed]);
      // Start retiring the prompt in the SAME commit as the last strike. `ended` follows
      // through the persisted replay and advances the remaining end sequence above.
      if (nextRun.ended) setPromptExiting(true);
      recordWordGuess(typed, nextRun.claimedRanks.length, nextRun.ended);

      if (judged.kind === 'claim') {
        setFocusRank({ rank: judged.entry.rank, at: Date.now() });
        say(srWordClaim(lang, judged.entry.word, judged.entry.rank, nextRun.claimedRanks.length));
        return;
      }
      if (judged.kind === 'near') {
        // A ranked near miss STRIKES but shows its rank — it teaches where the boundary is.
        setFocusRank({ rank: judged.entry.rank, at: Date.now() });
        say(srWordStrike(lang, judged.entry.rank, nextRun.strikes, STRIKES_TO_END, nextRun.ended));
        return;
      }
      say(srWordStrike(lang, null, nextRun.strikes, STRIKES_TO_END, nextRun.ended));
    },
    [ended, vocabSet, ranks, tried, recordWordGuess, lang, say],
  );

  if (!board) {
    // An artifact with no drawable geometry (no dq) cannot be played on this surface at
    // all — surface it as the load failure it is rather than a blank board.
    return <p className="status error">{t(lang, 'failedPuzzle')}</p>;
  }

  return (
    <div className="game word-game">
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      {/* The board IS the play surface: the day's neighborhood as the live route map. The
          WINDOW around it is a second, non-scrolling box — the torn rules that mark a cut-off
          edge have to stay put while the line moves under them (see `.scroll-torn`). */}
      <div
        className={`word-window scroll-torn${more.up ? ' more-up' : ''}${
          more.down ? ' more-down' : ''
        }`}
      >
        <div className="word-scroll pixel-scroll" ref={scrollRef} onScroll={readEdges}>
          <WordBoard model={board} lang={lang} />
        </div>
      </div>

      {/* One stable footer footprint: while playing it is prompt + keyboard; once the
          keyboard has dropped, the Word result overlays that WHOLE area: its score fills
          the flexible space while Share stays on the keyboard tray's bottom edge. Keeping
          the retired play controls underneath prevents either state from resizing the board. */}
      <div className="word-footer">
        <div className="word-footer-play">
          <div
            className={`input-area word-prompt${promptExiting ? ' solving' : ''}${
              showResults ? ' retired' : ''
            }`}
            aria-hidden={promptExiting || showResults || undefined}
          >
            <WordInput
              value={input}
              history={tried}
              onType={appendChar}
              onBackspace={deleteChar}
              onSubmit={submit}
              onReplace={replaceInput}
              invalidSignal={invalidAt}
              active={!ended}
            />
            {/* Keep the completed row through the settle/drop beats so the ending strike
                lands visibly. It remains mounted (hidden with the retired prompt) afterward
                to preserve the exact footer height under the overlaid result. */}
            <WordFailures lang={lang} strikes={run.strikes} />
          </div>

          <div className={`tray${keyboardLeaving ? ' kb-leaving' : ''}`}>
            {!showResults && (
              <div
                className={`kb-exit${keyboardLeaving ? ' leaving' : ''}`}
                onAnimationEnd={(event) => {
                  if (keyboardLeaving && event.target === event.currentTarget) {
                    finishKeyboardExit();
                  }
                }}
              >
                <Keyboard
                  input={input}
                  prefixSet={prefixSet}
                  vocabSet={vocabSet}
                  lang={lang}
                  onType={appendChar}
                  onBackspace={deleteChar}
                  onSubmit={submit}
                />
              </div>
            )}
          </div>
        </div>

        {showResults && !keyboardLeaving && (
          <div className="word-footer-result">
            <WordEndScreen
              score={score}
              dayNumber={dayNumber}
              lang={lang}
              animate={animateResults}
            />
          </div>
        )}
      </div>
    </div>
  );
}
