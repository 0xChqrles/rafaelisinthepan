import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { fold, type WordPuzzle } from '@whippin/shared';
import useVocab from '../hooks/useVocab';
import { useDeadlinePassed } from '../hooks/useCountdown';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import {
  judgeWordGuess,
  rarityOf,
  rarityStep,
  replayWordRun,
  totalBonus,
  wordGuessKey,
  RARITY_LADDER,
} from '../game/wordGame';
import { MISS_COLOR, MISS_HIT, RARITY_COLORS, RARITY_HIT } from '../components/rarity';
import { buildWordBoard } from '../game/wordBoard';
import { canExtend } from '../game/keyboard';
import useScrollEdges from '../hooks/useScrollEdges';
import WordBoard, { WordTerminus } from '../components/WordBoard';
import WordSubject, { type WordHit } from '../components/WordSubject';
import WordTimer, { type TimeGain } from '../components/WordTimer';
import CellDigits from '../components/CellDigits';
import Button from '../components/Button';
import { FLOATING_HIT_INTRO_MS } from './Game';
import { HIT_FADE_MS } from '../components/FloatingHit';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import WordEndScreen from '../components/WordEndScreen';
import LoadError from '../components/LoadError';
import { t, srWordClaim, srWordMiss, srWordTimeUp } from '../i18n';
import { prefersReducedMotion } from '../hooks/useScramble';

// Word mode (#156, retimed by #163): the second daily on the same mechanic, inverted —
// the word is SHOWN and the player names its neighborhood, fast, against a countdown.
// The screen runs in THREE phases, and each one puts a different thing in front of you:
//
//   GATE — the day's word, the rules in two sentences, and START. The clock needs a start
//          control anyway, so the control is where the rules live; this screen is also
//          the whole of Word mode's onboarding.
//   RUN  — the word, the prompt, the keyboard, the TIMER and the score, and nothing else.
//          The board does NOT render: this is a fast game, and a live map to read is a
//          contemplative surface that pulls against the clock.
//   OVER — the board arrives, revealed, as the post-mortem the run earned: the whole
//          census, the claims, the roads, the MISSED shelf, above the count and SHARE.
//
// The run's end is a DEADLINE, so it is the CLOCK that ends it and never a guess: an
// interrupted run is a ruined run (no pause, by decision), and a guess in flight when the
// clock dies is dead. See hooks/useCountdown and the round's deadline in state/gameStore.

// The ending plays in BEATS, like the sentence solve, instead of piling onto the frame
// the clock died in. First the killing moment plays out on the surface the player was
// looking at: the timer sits at 0 and the last guess's float finishes its whole run.
//
// This is the FLOOR of that beat, not its length. A rarity float holds longer the rarer
// the grade (#163 — components/rarity.ts RARITY_HIT), so an ARCANE landing on the buzzer
// outlives this by nearly a second; the screen tracks when the live float actually ends
// and waits for the later of the two. Getting that wrong would cut the run's best moment
// off mid-air to show the board.
const WORD_END_HOLD_MS = FLOATING_HIT_INTRO_MS + HIT_FADE_MS;
// Then the field arrives under the word and the prompt leaves; then the keyboard drops
// and the result rises. This beat is what separates the reveal from the drop — it is the
// board's own moment, with nothing else moving in it.
const WORD_END_SETTLE_MS = 320;
// Like Sentence mode's fallback: a lost animationend must not strand an empty result tray.
const KB_EXIT_FALLBACK_MS = 1_200;

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
  const startWordRun = useGameStore((s) => s.startWordRun);
  const recordWordGuess = useGameStore((s) => s.recordWordGuess);

  // Reconcile before paint, like the sentence round: a matching key playing the same
  // word rehydrates; a republished different word resets.
  useLayoutEffect(() => {
    ensureWordRound(roundKey, puzzle.word.slug);
  }, [ensureWordRound, roundKey, puzzle.word.slug]);

  const round = useGameStore((s) => s.wordRounds[roundKey]);
  const live = round && round.word === puzzle.word.slug ? round : undefined;
  const tried = live ? live.tried : [];
  const deadline = live ? live.deadline : null;
  const started = live ? live.startedAt !== null : false;

  // The clock, asked only what this screen has to know: has it run out? The seconds
  // themselves belong to the HUD, which subscribes to them itself — so the prompt and the
  // keyboard re-render on the player's input and on nothing else. Read off the deadline
  // and never counted down, so a reload mid-run resumes with the REAL remaining time and
  // a tab backgrounded past the end comes back to a finished round.
  const ended = useDeadlinePassed(deadline);
  const playing = started && !ended;

  // The player's whole vocabulary — and the scale rarity is measured against (#163): a
  // group's `freq` is a position in this list, so what counts as RARE is a fraction of it.
  // Already loaded before a round can accept a single guess, which is what makes it usable
  // as the economy's denominator at all.
  const corpusSize = vocabSet.size;

  // What the log MEANS — the claims, and the board's rows. Pure, so a reload reproduces
  // everything (the same contract as the sentence replay). What it does NOT say is whether
  // the run is over; that is the clock's, above.
  const run = useMemo(() => replayWordRun(ranks, tried), [ranks, tried]);
  const score = run.claimed.length;

  // End presentation is transient, not persisted. A live run lets the clock's last moment
  // play out, then the field arrives and the prompt leaves, then the keyboard drops and
  // the results rise. A rehydrated ended run initializes directly at the final frame.
  const [promptExiting, setPromptExiting] = useState(ended);
  const [keyboardLeaving, setKeyboardLeaving] = useState(false);
  // The post-mortem is its OWN BEAT: `ended` is the clock's fact, this is when the board
  // gets to arrive and say what the field held.
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
    // the global CSS rule cannot do it for them. Otherwise: the floor, or whatever is left
    // of the float still in the air, whichever is longer.
    const inFlight = Math.max(0, hitEndsAt.current - Date.now());
    const holdMs = prefersReducedMotion() ? 0 : Math.max(WORD_END_HOLD_MS, inFlight);
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

  // The board model. Only the POST-MORTEM draws it — the gate and the run show the bare
  // word (WordSubject) and no line at all — but it is built throughout, because the screen
  // refuses to render at all without a drawable one (see the `!board` guard below).
  const board = useMemo(
    () => buildWordBoard({ ranks, word: puzzle.word.word, tried, reveal: postMortem }),
    [ranks, puzzle.word.word, tried, postMortem],
  );

  // The seconds a claim just bought, landing ON the timer. Same shape as the word's hit:
  // a monotonic id, so two claims in a row restart the animation.
  const [gain, setGain] = useState<TimeGain | null>(null);
  const gainId = useRef(0);

  // Keep the arcade standing inside the real app header — the CLOCK, which is what this
  // mode is played against. The score is not here: it is the watermark. Absent when the
  // artifact has no drawable board, matching the load-failure body below.
  useLayoutEffect(() => {
    onHeaderLeftChange(board ? <WordTimer lang={lang} deadline={deadline} gain={gain} /> : null);
    return () => onHeaderLeftChange(null);
  }, [board, deadline, gain, lang, onHeaderLeftChange]);

  const [input, setInput] = useState('');
  const [invalidAt, setInvalidAt] = useState(0);

  // The floating feedback on the day's word: every counted guess reports there — its
  // RARITY GRADE, or MISS. A single target, so a single hit: no stagger, and the
  // intro-length fade delay a lone sentence hit gets, plus whatever hold the grade buys.
  // Free guesses (repeats, invalid words, the day's word itself) change no state and land
  // no hit, exactly as they fire no floating number in the sentence game.
  const [hit, setHit] = useState<WordHit | null>(null);
  const hitId = useRef(0);
  // When the float currently in the air stops existing. The ending's first beat waits for
  // it (see WORD_END_HOLD_MS) — a rarer grade holds longer, and the run's best find must
  // not be cut off to make room for the board.
  const hitEndsAt = useRef(0);
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

  // The clock running out is the one event of this game a reader would otherwise miss:
  // the timer itself is deliberately not a live region. Announced on the TRANSITION only
  // — the ref is seeded with the mount value, so opening an already-finished day states
  // nothing (its result is on screen to be read, not news).
  const announcedEnd = useRef(ended);
  useEffect(() => {
    if (!ended || announcedEnd.current) return;
    announcedEnd.current = true;
    say(srWordTimeUp(lang, score));
  }, [ended, lang, say, score]);

  // The post-mortem's scroller. It arrives parked at the bottom, where the line runs into
  // the pinned terminus word below it — the line is read up from that end, like the route
  // map opens on its own end. Nothing scrolls it during play any more: there IS no board
  // during play, which is what retired the whole claim-scroll animation this screen used
  // to run (SCROLL_MIN_MS/SCROLL_PX_PER_MS, the focused rank, the rAF loop).
  const scrollRef = useRef<HTMLDivElement>(null);
  // Which way the line still runs past the window's edges — the frame wears a torn dashed
  // rule on that side (the onboarding teaser's own vocabulary, shared with it in the hook).
  const { more, readEdges } = useScrollEdges(scrollRef);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    readEdges();
  }, [postMortem, readEdges]);

  // Same prefix rule as the sentence game: a dead-end char shakes the prompt instead of
  // being silently dropped (physical typing has no greyed key to look at). Read off the
  // current input rather than from inside a `setInput` updater — an updater has to be pure
  // (React runs it twice under StrictMode and may re-run it while rendering), and the
  // sentence game's own appendChar is written exactly this way.
  const appendChar = useCallback(
    (char: string) => {
      if (!playing) return;
      if (canExtend(prefixSet, input, char)) setInput(input + char);
      else setInvalidAt(Date.now());
    },
    [playing, input, prefixSet],
  );

  const deleteChar = useCallback(() => {
    if (!playing) return;
    setInput((cur) => cur.slice(0, -1));
  }, [playing]);

  const replaceInput = useCallback(
    (v: string) => {
      if (!playing) return;
      setInput(v);
    },
    [playing],
  );

  const submit = useCallback(
    (raw: string) => {
      if (!playing) return;
      const typed = fold(raw);
      if (!typed) {
        setInput('');
        return;
      }

      // Existence is decided by the fixed vocabulary, never by the rank map. Invalid is
      // FREE — shake + message — and the timer is what charges for it: the seconds it
      // took to type. That is the whole of what the strike system used to legislate.
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

      // A COUNTED guess: append it, and let the store re-price the log it just appended
      // to (see gameStore's WordRunCache for why the store replays rather than being
      // handed the numbers). The DEADLINE moves through that same write — a claim's
      // bonus reaches the clock as the round's new deadline, not as a number this screen
      // adds up — and the store judges the submission against the clock as of now, so a
      // guess entered as the last second ran out lands or dies on one authority.
      const landed = recordWordGuess(typed, (log) => {
        const stored = replayWordRun(ranks, log);
        return { claimed: stored.claimed.length, bonus: totalBonus(stored.claimed, corpusSize) };
      });
      // NOTHING is reported unless the store took the guess. `playing` is a RENDERED value
      // and the clock is wall-clock, so between the deadline and the re-render that
      // notices it there is a window — small, but exactly the window a player racing a
      // timer types in — where this handler still runs and the store correctly refuses.
      // Showing the feedback anyway would float a grade, pay a `+21s` gain and announce
      // "claimed …" for a find the run never took. The store checks the real clock at the
      // instant of the write, and this defers to it.
      if (!landed) return;

      // This render's own view of the same walk, for the feedback THIS guess speaks.
      const nextRun = replayWordRun(ranks, [...tried, typed]);

      // What the word says back. A claim names its GRADE; anything the run cannot claim
      // says MISS in the app's red — a near miss and an off-map guess are the same event
      // to a player racing a clock, and the exact distance of an unclaimable word is a
      // number they can do nothing with. It survives where it still teaches: the
      // post-mortem draws that guess on the trunk at its real rank.
      const claimed = judged.kind === 'claim' ? judged.entry : null;
      const grade = claimed ? rarityOf(claimed.freq, corpusSize) : null;
      const style = grade ? RARITY_HIT[rarityStep(grade)] : MISS_HIT;
      hitId.current += 1;
      const fadeDelayMs = FLOATING_HIT_INTRO_MS + style.holdMs;
      hitEndsAt.current = Date.now() + fadeDelayMs + HIT_FADE_MS;
      setHit({
        id: hitId.current,
        label: grade ?? 'MISS',
        color: grade ? RARITY_COLORS[grade] : MISS_COLOR,
        scale: style.scale,
        lift: style.lift,
        rise: style.rise,
        punch: style.punch,
        shake: style.shake,
        fadeDelayMs,
      });

      if (claimed && grade) {
        // The other half of the feedback grammar: the GRADE lands on the word, the
        // SECONDS it bought land on the clock.
        const seconds = RARITY_LADDER[rarityStep(grade)].seconds;
        gainId.current += 1;
        setGain({ id: gainId.current, seconds });
        say(srWordClaim(lang, claimed.word, grade, nextRun.claimed.length, seconds));
        return;
      }
      say(srWordMiss(lang));
    },
    [playing, vocabSet, corpusSize, ranks, tried, recordWordGuess, lang, say],
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

      {/* The day's word is on screen in every phase — it is the whole game — and the
          post-mortem's line grows in ABOVE it, so the word itself never moves between the
          run and the reveal. The WINDOW around all of it is a non-scrolling box: the torn
          rules that mark a cut-off edge have to stay put while the line moves under them
          (see `.scroll-torn`). */}
      <div className="word-window">
        {postMortem && (
          /* The CUT wears the torn edges, not the window: the terminus below is the
             window's last child, and a tear on the window's own bottom edge would draw
             under it — the cut is where the SCROLLER ends, which is where the line can be
             severed mid-field (its bottom rule lands on the terminus's rail stub). */
          <div
            className={`word-cut scroll-torn${more.up ? ' more-up' : ''}${
              more.down ? ' more-down' : ''
            }`}
          >
            <div className="word-scroll pixel-scroll" ref={scrollRef} onScroll={readEdges}>
              <WordBoard model={board} lang={lang} />
            </div>
          </div>
        )}
        {/* The SCORE watermark, anchored on the word rather than the viewport — the
            standing rule for this number, and the mode's own reading of it: the count is
            what the end screen will name, so during the run it is the thing behind
            everything. It goes with the reveal: the board is what fills that space then,
            and the tray states the count for real. */}
        <div className="word-anchor">
          {playing && (
            <div className="progress-background" aria-hidden="true">
              <CellDigits value={score} />
            </div>
          )}
          {/* Two halves of one word. Until the clock dies there is no line, so there is
              nothing for a station to be the end OF: the word stands on its own, centred,
              and every guess reports on it. The post-mortem brings the real terminus back
              as what it is — the last stop of the revealed route. */}
          {postMortem ? (
            <WordTerminus model={board} />
          ) : (
            <WordSubject word={puzzle.word.word} lang={lang} hit={hit} onHitDone={clearHit} />
          )}
        </div>
      </div>

      {/* One stable footer footprint across all three phases: the gate's rules + START,
          then prompt + keyboard, then the result overlaying that WHOLE area — its score
          fills the flexible space while Share stays on the keyboard tray's bottom edge.
          Keeping the retired play controls underneath prevents any state from resizing
          the surface above. */}
      <div className="word-footer">
        <div className="word-footer-play">
          {!started ? (
            /* The GATE. Two sentences and the control that starts the clock: what to do,
               and what buys more time to do it in. It sits exactly where the prompt and
               keyboard will be, so tapping START changes what the footer holds and not
               where anything is. */
            <>
              <p className="word-rules">
                {t(lang, 'wordRulesGoal')}
                <br />
                {t(lang, 'wordRulesBonus')}
              </p>
              <div className="tray">
                <Button className="word-start" onClick={startWordRun}>
                  {t(lang, 'wordStart')}
                </Button>
              </div>
            </>
          ) : (
            <>
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
                  active={playing}
                />
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
            </>
          )}
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
