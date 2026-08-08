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
import WordBoard, { WordTerminus, type WordHit } from '../components/WordBoard';
import { FLOATING_HIT_INTRO_MS } from './Game';
import { HIT_FADE_MS } from '../components/FloatingHit';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import WordEndScreen from '../components/WordEndScreen';
import LoadError from '../components/LoadError';
import { t, srWordClaim, srWordFailures, srWordStrike } from '../i18n';
import { prefersReducedMotion } from '../hooks/useScramble';

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
// The ending plays in BEATS, like the sentence solve, instead of piling onto the killing
// strike's own frame (which is where everything used to land at once — the reveal, the
// scroll and the prompt exit, all under a MISS still floating). First the strike plays out
// in full on a still board: the third cross fills and the terminus hit runs its whole
// float, which is exactly this long.
const WORD_END_HOLD_MS = FLOATING_HIT_INTRO_MS + HIT_FADE_MS;
// Then the post-mortem names the field and the line runs to its true bottom — one
// board-scroll beat, with the prompt leaving under it — before the keyboard drops.
const WORD_END_SETTLE_MS = SCROLL_MAX_MS;
// Like Sentence mode's fallback: a lost animationend must not strand an empty result tray.
const KB_EXIT_FALLBACK_MS = 1_200;
// Ease OUT only: the move starts at full speed (it is a reaction to the guess just
// submitted) and settles onto the station.
const easeOutScroll = (t: number) => 1 - (1 - t) ** 3;

// A claim RESETS the strike run, and the crosses go out ONE AT A TIME rather than in a
// single frame: each un-presses CROSS_WAVE_MS after the one to its right, rewinding the row
// the way it filled. Short on purpose — a flourish on a state change, not a beat the player
// waits through: a full row clears in 280ms, under the board scroll running alongside it.
// Filling is NOT staggered; a strike is a hit and lands at once.
const CROSS_WAVE_MS = 70;

// One cross of the failure row, straight off `cross-button.png` — a two-frame 11x11 sheet
// where frame 0 is the un-pressed button and frame 1 the pressed red fail. Both colours are
// baked into the sprite, which is what retired the canvas recolor this used to run: the old
// single-frame `fail.png` carried a placeholder red that had to be repainted per state at
// runtime, so the row stayed blank until an async decode finished. One frame per state needs
// none of it — the sheet is a plain background and the state is a background-position.
function FailIcon({ filled }: { filled: boolean }) {
  return <span className={`strike-pip${filled ? ' failed' : ''}`} aria-hidden="true" />;
}

function WordScore({ value }: { value: number }) {
  return (
    <span className="word-count" aria-hidden="true">
      {String(value)
        .split('')
        .map((digit, index) => {
          // digits.png is ten 7px slots ordered 1..9,0 — so '0' is the LAST one, not the
          // first. Drawn at the header's 4x pixel scale, which is where 28 comes from: the
          // step below and `.word-digit`'s 280x28 mask-size are that same scale and have to
          // move together with it.
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
  // How many crosses the ROW shows, which trails `strikes` only while a reset sweeps them
  // out. It starts AT the count, so a rehydrated round renders its strikes settled and
  // replays no wave.
  const [shown, setShown] = useState(strikes);

  useEffect(() => {
    // Filling — and a reduced-motion reset, since this is a JS timer and the global CSS
    // rule collapses durations but not delays — happens in this frame.
    if (strikes >= shown || prefersReducedMotion()) {
      setShown(strikes);
      return undefined;
    }
    // Otherwise one cross per tick, rightmost first. The effect re-runs on its own result
    // until the row has caught up, so the sweep needs no schedule of its own, and a strike
    // landing mid-wave simply ends it through the branch above.
    const timer = window.setTimeout(() => setShown((n) => n - 1), CROSS_WAVE_MS);
    return () => window.clearTimeout(timer);
  }, [shown, strikes]);

  return (
    <div
      className="word-strikes"
      role="img"
      // The reader hears the real count, never the animation trailing it.
      aria-label={srWordFailures(lang, strikes, STRIKES_TO_END)}
    >
      {Array.from({ length: STRIKES_TO_END }, (_, i) => (
        <FailIcon key={i} filled={i < shown} />
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

  // End presentation is transient, not persisted. A live run lets the killing strike play
  // out on the still board, then reveals the post-mortem and scrolls to the word, then
  // drops the keyboard and raises the results. A rehydrated ended run initializes directly
  // at the final frame.
  const [promptExiting, setPromptExiting] = useState(false);
  const [keyboardLeaving, setKeyboardLeaving] = useState(false);
  // The post-mortem reveal is ITS OWN BEAT, not the strike's frame: `ended` is the run's
  // fact, this is when the board gets to say it.
  const [postMortem, setPostMortem] = useState(ended);
  const [showResults, setShowResults] = useState(ended);
  const [animateResults, setAnimateResults] = useState(false);
  const previousEnded = useRef(ended);
  useEffect(() => {
    const justEnded = ended && !previousEnded.current;
    previousEnded.current = ended;
    if (!justEnded) return undefined;

    setAnimateResults(true);
    // Reduced motion collapses the beats to their state changes — these are JS timers, so
    // the global CSS rule cannot do it for them.
    const holdMs = prefersReducedMotion() ? 0 : WORD_END_HOLD_MS;
    const settleMs = prefersReducedMotion() ? 0 : WORD_END_SETTLE_MS;
    const reveal = window.setTimeout(() => {
      setPostMortem(true);
      setPromptExiting(true);
    }, holdMs);
    const kb = window.setTimeout(() => setKeyboardLeaving(true), holdMs + settleMs);
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(kb);
    };
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
    () => buildWordBoard({ ranks, word: puzzle.word.word, tried, reveal: postMortem }),
    [ranks, puzzle.word.word, tried, postMortem],
  );

  // Keep the arcade standing inside the real app header. The status is absent when the
  // artifact has no drawable board, matching the load-failure body below.
  useLayoutEffect(() => {
    onHeaderLeftChange(board ? <WordHeaderStatus lang={lang} score={score} /> : null);
    return () => onHeaderLeftChange(null);
  }, [board, lang, onHeaderLeftChange, score]);

  const [input, setInput] = useState('');
  const [invalidAt, setInvalidAt] = useState(0);

  // The floating hit on the terminus: every counted guess reports there — the rank it earned,
  // or MISS — with the sentence game's own animation (a single target, so a single hit: no
  // stagger, and the intro-length fade delay a lone sentence hit gets). Free guesses (repeats,
  // invalid words, the day's word itself) change no state and land no hit, exactly as they
  // fire no floating number in the sentence game.
  const [hit, setHit] = useState<WordHit | null>(null);
  const hitId = useRef(0);
  const clearHit = useCallback((id: number) => {
    setHit((cur) => (cur && cur.id === id ? null : cur));
  }, []);

  // Screen-reader mirror of the guess feedback (same pattern as the sentence round).
  const [announce, setAnnounce] = useState('');
  const announceFlip = useRef(false);
  const say = useCallback((text: string) => {
    announceFlip.current = !announceFlip.current;
    setAnnounce(text + (announceFlip.current ? '' : '​'));
  }, []);

  // The board scroller. It opens parked at the bottom, where the line runs into the pinned
  // terminus word below it — the line is read up from that end, like the route map opens on
  // its own end — and a CLAIM scrolls its station into view so the find is seen landing.
  //
  // ONLY a claim (decided 2026-08-06). A strike used to move the board too, out to the near
  // miss's own row on the trunk: it strikes, so the player is being carried AWAY from the
  // field they are working on, and then has to find their way back before the next guess.
  // The move is a reward for a find, not a report on a failure — the cross row and the
  // floating rank already say what happened, and they say it without moving the ground. (An
  // off-map miss has no row to move to and never scrolled.)
  const scrollRef = useRef<HTMLDivElement>(null);
  // Boxed rather than a bare number so that landing on the SAME rank twice still moves the
  // board: a fresh object is never `Object.is` the last one, which is what re-runs the
  // effect below.
  const [focusRank, setFocusRank] = useState<{ rank: number } | null>(null);
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
  // Move onto the station a CLAIM just landed on; on the post-mortem beat, the terminus
  // takes priority and the view returns to the true bottom of the routes. Driven here
  // rather than by `scrollIntoView({ behavior: 'smooth' })`, whose duration is the BROWSER's
  // and scales with the distance travelled: the field is CLAIM_ZONE rows, so a claim out at the
  // far edge crawled for the better part of a second before the player could see where it
  // landed — and the next guess is typeable the whole time. On this clock the move is over
  // in a beat, with the distance changing it only inside a narrow band.
  useLayoutEffect(() => {
    if (!postMortem && !focusRank) return undefined;
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const from = scroller.scrollTop;
    const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    let to = bottom;
    if (!postMortem && focusRank) {
      const station = scroller.querySelector<HTMLElement>(`[data-route-rank="${focusRank.rank}"]`);
      if (!station) return undefined;
      // Centre a live station in the window, clamped into the scroll range. Measured off
      // RECTS, never offsetTop: `.route-frame` is positioned, so IT is the offsetParent
      // rather than the scroller, and the two coordinate spaces differ (the shared
      // `offsetWithin` exists for exactly that trap). Nothing here is mid-transform,
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
  }, [postMortem, focusRank]);

  // Same prefix rule as the sentence game: a dead-end char shakes the prompt instead of
  // being silently dropped (physical typing has no greyed key to look at). Read off the
  // current input rather than from inside a `setInput` updater — an updater has to be pure
  // (React runs it twice under StrictMode and may re-run it while rendering), and the
  // sentence game's own appendChar is written exactly this way.
  const appendChar = useCallback(
    (char: string) => {
      if (ended) return;
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [ended, input, prefixSet],
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

      // A COUNTED guess: append it, and let the store replay the log it just appended to
      // for the cached claim count / end state the archive and selector badge a day with
      // (see gameStore's WordRunCache for why the store replays rather than being handed
      // the numbers). On the last strike, `ended` follows through that persisted replay and
      // the effect above runs the end beats — the prompt stays for the hold, so the strike
      // is SEEN landing.
      recordWordGuess(typed, (log) => {
        const stored = replayWordRun(ranks, log);
        return { claimed: stored.claimedRanks.length, ended: stored.ended };
      });
      // This render's own view of the same walk, for the feedback THIS guess speaks.
      const nextRun = replayWordRun(ranks, [...tried, typed]);

      // Every counted guess lands its hit on the terminus. `judged` here is claim/near/miss —
      // zero already returned above, and free guesses never reach this point.
      hitId.current += 1;
      setHit({
        id: hitId.current,
        value: judged.kind === 'miss' ? 0 : judged.entry.rank,
        miss: judged.kind === 'miss',
        startDelayMs: 0,
        fadeDelayMs: FLOATING_HIT_INTRO_MS,
      });

      if (judged.kind === 'claim') {
        setFocusRank({ rank: judged.entry.rank });
        say(srWordClaim(lang, judged.entry.word, judged.entry.rank, nextRun.claimedRanks.length));
        return;
      }
      if (judged.kind === 'near') {
        // A ranked near miss STRIKES but shows its rank — it teaches where the boundary is.
        // It does NOT move the board: a strike must not carry the player off the field they
        // are working on (see the scroller's comment above). Its row is drawn on the trunk
        // either way, to be found on the way past.
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
      <div className="word-window">
        {/* The CUT wears the torn edges, not the window: the terminus footer below is the
            window's last child, and a tear on the window's own bottom edge would draw under
            the footer — the cut is where the SCROLLER ends, which is where the line can be
            severed mid-field (its bottom rule lands on the footer's top edge, right where
            the terminus's rail stub runs into it). */}
        <div
          className={`word-cut scroll-torn${more.up ? ' more-up' : ''}${
            more.down ? ' more-down' : ''
          }`}
        >
          <div className="word-scroll pixel-scroll" ref={scrollRef} onScroll={readEdges}>
            <WordBoard model={board} lang={lang} />
          </div>
        </div>
        {/* The day's word, pinned under the cut — always on screen, never scrolled behind. */}
        <WordTerminus model={board} hit={hit} onHitDone={clearHit} />
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
              word={puzzle.word.word}
              animate={animateResults}
            />
          </div>
        )}
      </div>
    </div>
  );
}
