import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fold, heatColor, type WordPuzzle } from '@whippin/shared';
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
import { rankHeatColor, HIT_HEAT_CAP } from '../components/Hole';
import { t, srWordClaim, srWordStrike } from '../i18n';

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
// Ease OUT only: the move starts at full speed (it is a reaction to the guess just
// submitted) and settles onto the station.
const easeOutScroll = (t: number) => 1 - (1 - t) ** 3;

// The guess feedback under the input — Word mode's one hole is the WORD, always on
// screen, so the under-input line carries the per-guess outcome (the sentence game's
// feedback grammar splits this between the holes and the input; here they are the same
// place).
type WordFeedback =
  | { kind: 'invalid' }
  | { kind: 'repeat' }
  | { kind: 'zero' }
  | { kind: 'claim'; word: string; rank: number }
  | { kind: 'near'; rank: number }
  | { kind: 'miss' };

export default function WordGame({
  puzzle,
  dayNumber,
}: {
  puzzle: WordPuzzle;
  dayNumber: number;
}) {
  const { vocab, error, retry } = useVocab(puzzle.lang);

  if (error !== null) {
    return <LoadError message={t(puzzle.lang, 'failedVocab')} lang={puzzle.lang} onRetry={retry} />;
  }
  if (!vocab) return <p className="status">{t(puzzle.lang, 'loading')}</p>;

  return (
    <WordRound
      puzzle={puzzle}
      vocabSet={vocab.vocabSet}
      prefixSet={vocab.prefixSet}
      dayNumber={dayNumber}
    />
  );
}

function WordRound({
  puzzle,
  vocabSet,
  prefixSet,
  dayNumber,
}: {
  puzzle: WordPuzzle;
  vocabSet: Set<string>;
  prefixSet: Set<string>;
  dayNumber: number;
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

  const board = useMemo(
    () => buildWordBoard({ ranks, word: puzzle.word.word, tried }),
    [ranks, puzzle.word.word, tried],
  );

  const [input, setInput] = useState('');
  const [feedback, setFeedback] = useState<WordFeedback | null>(null);
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
  // The move onto the station a counted guess just landed on. Driven here rather than by
  // `scrollIntoView({ behavior: 'smooth' })`, whose duration is the BROWSER's and scales
  // with the distance travelled: the field is ~150 rows, so a claim out at the far edge
  // crawled for the better part of a second before the player could see where it had
  // landed — and the next guess is typeable the whole time. On this clock the move is over
  // in a beat, with the distance changing it only inside a narrow band.
  useLayoutEffect(() => {
    if (!focusRank) return undefined;
    const scroller = scrollRef.current;
    const station = scroller?.querySelector<HTMLElement>(`[data-word-rank="${focusRank.rank}"]`);
    if (!scroller || !station) return undefined;
    // Centre the station in the window, clamped into the scroll range. Measured off RECTS,
    // never offsetTop: `.route-frame` is positioned, so IT is the offsetParent rather than
    // the scroller, and the two coordinate spaces differ (the route map's own `offsetWithin`
    // exists for exactly that trap). Nothing here is mid-transform, so rects are honest.
    const stationBox = station.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    const from = scroller.scrollTop;
    const to = Math.max(
      0,
      Math.min(
        from +
          stationBox.top +
          stationBox.height / 2 -
          (scrollerBox.top + scroller.clientHeight / 2),
        scroller.scrollHeight - scroller.clientHeight,
      ),
    );
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
  }, [focusRank]);

  // Same prefix rule as the sentence game: a dead-end char shakes the prompt instead of
  // being silently dropped (physical typing has no greyed key to look at).
  const appendChar = useCallback(
    (char: string) => {
      if (ended) return;
      setFeedback(null);
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
    setFeedback(null);
    setInput((cur) => cur.slice(0, -1));
  }, [ended]);

  const replaceInput = useCallback(
    (v: string) => {
      if (ended) return;
      setFeedback(null);
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
        setFeedback({ kind: 'invalid' });
        say(t(lang, 'notAWord'));
        return;
      }

      setInput('');

      // Repeats are FREE, deduped at GROUP level (#104): an inflection or accent alias
      // of an already-counted guess shares its group's rank, so it never re-counts —
      // and never enters the persisted log.
      const key = wordGuessKey(ranks, typed);
      if (tried.some((prev) => wordGuessKey(ranks, prev) === key)) {
        setFeedback({ kind: 'repeat' });
        say(t(lang, 'wordRepeat'));
        return;
      }

      const judged = judgeWordGuess(ranks, typed);
      // The day's word itself is public — typing it is free, not a claim.
      if (judged.kind === 'zero') {
        setFeedback({ kind: 'zero' });
        say(t(lang, 'wordItself'));
        return;
      }

      // A COUNTED guess: append it and cache the replayed claim count / end state, so
      // the archive and selector can badge the day without this rank map.
      const nextRun = replayWordRun(ranks, [...tried, typed]);
      recordWordGuess(typed, nextRun.claimedRanks.length, nextRun.ended);

      if (judged.kind === 'claim') {
        setFeedback({ kind: 'claim', word: judged.entry.word, rank: judged.entry.rank });
        setFocusRank({ rank: judged.entry.rank, at: Date.now() });
        say(srWordClaim(lang, judged.entry.word, judged.entry.rank, nextRun.claimedRanks.length));
        return;
      }
      if (judged.kind === 'near') {
        // A ranked near miss STRIKES but shows its rank — it teaches where the boundary is.
        setFeedback({ kind: 'near', rank: judged.entry.rank });
        setFocusRank({ rank: judged.entry.rank, at: Date.now() });
        say(srWordStrike(lang, judged.entry.rank, nextRun.strikes, STRIKES_TO_END, nextRun.ended));
        return;
      }
      setFeedback({ kind: 'miss' });
      say(srWordStrike(lang, null, nextRun.strikes, STRIKES_TO_END, nextRun.ended));
    },
    [ended, vocabSet, ranks, tried, recordWordGuess, lang, say],
  );

  // The under-input feedback line, in the game's own color language: a claim wears its
  // rank's heat, a strike the coldest heat, everything else stays muted.
  const hint = (() => {
    if (!feedback) return <span> </span>;
    switch (feedback.kind) {
      case 'invalid':
        return <span>{t(lang, 'notAWord')}</span>;
      case 'repeat':
        return <span>{t(lang, 'wordRepeat')}</span>;
      case 'zero':
        return <span>{t(lang, 'wordItself')}</span>;
      case 'claim':
        return (
          <span style={{ color: rankHeatColor(feedback.rank, HIT_HEAT_CAP) }}>
            {feedback.word} -{feedback.rank}
          </span>
        );
      case 'near':
        return <span style={{ color: heatColor(0) }}>-{feedback.rank}</span>;
      case 'miss':
        return <span style={{ color: heatColor(0) }}>MISS</span>;
    }
  })();

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

      {/* The arcade corner: the claim COUNT (the score — higher is better here) and the
          strike pips, which fill as the consecutive-incorrect run grows and empty on a
          claim. */}
      <div className="hud">
        <span className="word-hud">
          <span className="word-count">{score}</span>
          <span className="word-strikes" aria-hidden="true">
            {Array.from({ length: STRIKES_TO_END }, (_, i) => (
              <i key={i} className={`strike-pip${i < run.strikes ? ' hit' : ''}`} />
            ))}
          </span>
          <span className="sr-only">
            {`${score} ${t(lang, score === 1 ? 'word' : 'words')} — ${run.strikes}/${STRIKES_TO_END}`}
          </span>
        </span>
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

      <div className={`input-area word-prompt${ended ? ' retired' : ''}`} aria-hidden={ended || undefined}>
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
        <p className="hint">{hint}</p>
      </div>

      <div className={`tray${ended ? ' tray-results' : ''}`}>
        {ended ? (
          <WordEndScreen score={score} dayNumber={dayNumber} lang={lang} />
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
    </div>
  );
}
