import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MISS_COLOR, fold, type WordPuzzle } from '@whippin/shared';
import LoadingWave from '../components/LoadingWave';
import useVocab from '../hooks/useVocab';
import { KB_EXIT_FALLBACK_MS } from './Game';
import { useDeadlinePassed } from '../hooks/useCountdown';
import useScoreHistogram from '../hooks/useScoreHistogram';
import { useGameStore, roundKeyForDay } from '../state/gameStore';
import {
  bonusSeconds,
  judgeWordGuess,
  rarityOf,
  rarityStep,
  replayWordRun,
  totalBonus,
  wordGuessKey,
  CLAIM_ZONE,
  RARITY_NAMES,
} from '../game/wordGame';
import { RARITY_COLORS, strikeFor } from '../components/rarity';
import { buildWordBoard } from '../game/wordBoard';
import { canExtend } from '../game/keyboard';
import useScrollEdges from '../hooks/useScrollEdges';
import WordBoard, { WordTerminus } from '../components/WordBoard';
import WordSubject, { hitDurationMs, type WordHit } from '../components/WordSubject';
import WordTimer, { type TimeGain } from '../components/WordTimer';
import PuzzleDate from '../components/PuzzleDate';
import CellDigits from '../components/CellDigits';
import WordInput from '../components/WordInput';
import Keyboard from '../components/Keyboard';
import WordEndScreen from '../components/WordEndScreen';
import LoadError from '../components/LoadError';
import CoachText from '../tutorial/CoachText';
import { t, tn, srWordClaim, srWordMiss, srWordTimeUp } from '../i18n';
import { prefersReducedMotion } from '../hooks/useScramble';

// Word mode (#156, retimed by #163): the second daily on the same mechanic, inverted —
// the word is SHOWN and the player names its neighborhood, fast, against a countdown.
// The screen runs in THREE phases, and each one puts a different thing in front of you:
//
//   GATE — the day's word, two bulleted rules in the shared `.coach-rules` dialog, and
//          PLAY. The clock needs a start
//          control anyway, so the control is where the rules live; this screen is also
//          the whole of Word mode's onboarding.
//   RUN  — the word, the prompt, the keyboard, the TIMER and the score, and nothing else.
//          The board does NOT render: this is a fast game, and a live map to read is a
//          contemplative surface that pulls against the clock.
//   OVER — the board arrives, revealed, as the post-mortem the run earned: the whole
//          census, the claims coloured by RARITY (what each grade held and paid),
//          the MISSED shelf, above the count and SHARE.
//
// The run's end is a DEADLINE, so it is the CLOCK that ends it and never a guess: an
// interrupted run is a ruined run (no pause, by decision), and a guess in flight when the
// clock dies is dead. See hooks/useCountdown and the round's deadline in state/gameStore.

// The ending plays in BEATS, like the sentence solve, instead of piling onto the frame
// the clock died in. First the killing moment plays out on the surface the player was
// looking at: the timer sits at 0 and the last guess's strike finishes landing.
//
// This is the FLOOR of that beat, not its length: a doubled slash runs longer than a single
// one, so the screen tracks when whatever is in the air actually ends and waits for the
// later of the two. Getting that wrong would cut the run's last strike off mid-swing to
// show the board.
const WORD_END_HOLD_MS = 800;
// Then the field arrives under the word and the prompt leaves; then the keyboard drops
// and the result rises. This beat is what separates the reveal from the drop — it is the
// board's own moment, with nothing else moving in it.
const WORD_END_SETTLE_MS = 320;

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
  if (!vocab)
    return (
      <p className="status">
        <LoadingWave text={t(puzzle.lang, 'loading')} />
      </p>
    );

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

  // The gate's rules as ONE bulleted string: what its dialog box types, and what the
  // sr-only mirror states (the visible CoachText is aria-hidden, like every coach box).
  // The goal line names HOW MANY words count, read off `CLAIM_ZONE` rather than written
  // into the copy — the rule and the sentence stating it cannot drift apart.
  const gateRules = useMemo(
    () =>
      [tn(lang, 'wordRulesGoal', CLAIM_ZONE), t(lang, 'wordRulesBonus')]
        .map((line) => `- ${line}`)
        .join('\n'),
    [lang],
  );
  const ensureWordRound = useGameStore((s) => s.ensureWordRound);
  const startWordRun = useGameStore((s) => s.startWordRun);
  const recordWordGuess = useGameStore((s) => s.recordWordGuess);
  const markWordScoreSubmitted = useGameStore((s) => s.markWordScoreSubmitted);
  // The score request outlives this screen if the player navigates away. Keep its
  // completion attached to the round that launched it, never the next active Word day.
  const markThisWordScoreSubmitted = useCallback(
    () => markWordScoreSubmitted(roundKey),
    [markWordScoreSubmitted, roundKey],
  );

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

  // The day's score population (#170): a run whose clock has died submits its claim count
  // once — including a run that ended while the tab was closed, whose first submission
  // happens on the revisit that finds it over — and the persisted scoreSubmitted flag
  // turns every later visit into a read-only GET. Renders on the post-mortem only.
  const placement = useScoreHistogram({
    finished: ended,
    submitted: live?.scoreSubmitted === true,
    markSubmitted: markThisWordScoreSubmitted,
    mode: 'word',
    lang,
    dayNumber,
    score,
  });

  // The claims broken down by grade, ladder order — what the end screen's share text, the
  // share token and the OG card all carry. Derived from the same replay as the score, so
  // the breakdown and the count can never disagree (their sum IS the score).
  const rarityCounts = useMemo(() => {
    const counts = RARITY_NAMES.map(() => 0);
    for (const entry of run.claimed) counts[rarityStep(rarityOf(entry.freq, corpusSize))] += 1;
    return counts;
  }, [run, corpusSize]);

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
    () => buildWordBoard({ ranks, word: puzzle.word.word, tried, corpusSize, reveal: postMortem }),
    [ranks, puzzle.word.word, tried, corpusSize, postMortem],
  );

  // The seconds a claim just bought, landing ON the timer. Same shape as the word's hit:
  // a monotonic id, so two claims in a row restart the animation.
  const [gain, setGain] = useState<TimeGain | null>(null);
  const gainId = useRef(0);

  // The header's left slot holds the DATE CHIP — the archive entry, like the sentence
  // game's (user-decided 2026-08-18; the CLOCK moved down under the word, where the
  // playing eye already lives). Absent when the artifact has no drawable board, matching
  // the load-failure body below.
  useLayoutEffect(() => {
    onHeaderLeftChange(
      board ? <PuzzleDate dayNumber={dayNumber} lang={lang} mode="word" /> : null,
    );
    return () => onHeaderLeftChange(null);
  }, [board, dayNumber, lang, onHeaderLeftChange]);

  const [input, setInput] = useState('');
  const [invalidAt, setInvalidAt] = useState(0);

  // The feedback on the day's word: every counted guess reports there — its RARITY GRADE,
  // or MISS. Free guesses (repeats, invalid words, the day's word itself) change no state
  // and show nothing, exactly as they float nothing in the sentence game.
  const [hit, setHit] = useState<WordHit | null>(null);
  const hitId = useRef(0);
  // When the label currently on screen goes. The ending's first beat waits for it (see
  // WORD_END_HOLD_MS) — a rarer grade stays longer, and the run's best find must not be cut
  // short to make room for the board.
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

      // What the word says back — and the two answers are different EVENTS, not two
      // spellings of one. A claim STRIKES the word in its grade's colour and knocks its
      // LOOT out of it — the guess's rank exponent and the grade's name, popping off the
      // word and falling away (WordLoot). Anything the run cannot claim says MISS in the
      // ramp's weird-terminus red: a near miss and an off-map guess are the same thing to a player racing
      // a clock, and the exact distance of an unclaimable word is a number they can do
      // nothing with. It survives where it still teaches — the post-mortem draws that
      // guess on the trunk at its real rank.
      const claimed = judged.kind === 'claim' ? judged.entry : null;
      const grade = claimed ? rarityOf(claimed.freq, corpusSize) : null;
      hitId.current += 1;
      const next: WordHit =
        claimed && grade
          ? {
              id: hitId.current,
              kind: 'claim',
              color: RARITY_COLORS[grade],
              strike: strikeFor(grade),
              rank: claimed.rank,
              grade,
            }
          : { id: hitId.current, kind: 'miss', color: MISS_COLOR };
      hitEndsAt.current = Date.now() + hitDurationMs(next);
      setHit(next);

      if (claimed && grade) {
        // The other half of the feedback grammar: the GRADE lands on the word, the
        // SECONDS it bought land on the clock — priced by `bonusSeconds`, the SAME
        // derivation the store's re-pricing walks through (`totalBonus`), so the `+Ns`
        // shown and the seconds credited can never disagree.
        const seconds = bonusSeconds(claimed.freq, corpusSize);
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
            <>
              <WordSubject word={puzzle.word.word} lang={lang} hit={hit} onHitDone={clearHit} />
              {/* The CLOCK, under the word since 2026-08-18 (freeing the header's left
                  slot for the date chip): the resource this mode is played against,
                  right where the playing eye lives — idle preview on the gate, live
                  countdown during the run; the post-mortem needs no clock at all. */}
              <div className="word-clock">
                <WordTimer lang={lang} deadline={deadline} gain={gain} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* One stable footer footprint across all three phases: the gate's rules + PLAY,
          then prompt + keyboard, then the result overlaying that WHOLE area — its score
          fills the flexible space while Share stays on the keyboard tray's bottom edge.
          Keeping the retired play controls underneath prevents any state from resizing
          the surface above. */}
      <div className="word-footer">
        <div className="word-footer-play">
          {!started ? (
            /* The GATE — the sentence gate's EXACT layout (user-decided 2026-08-11):
               the rules in the shared `.coach-rules` dialog and a full-width PLAY,
               stacked in `.rules-gate` on the tray's bottom edge, extra height rising
               upward (`.tray.tray-gate`). What to do, and what buys more time to do it
               in; tapping PLAY swaps the tray's contents for the prompt and keys. */
            <div className="tray tray-gate">
              <div className="rules-gate">
                <p className="sr-only">{gateRules}</p>
                <div className="coach-rules" aria-hidden="true">
                  <CoachText copy={gateRules} />
                </div>
                <button type="button" className="mix-btn" onClick={startWordRun}>
                  {t(lang, 'gatePlay')}
                </button>
              </div>
            </div>
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
              counts={rarityCounts}
              dayNumber={dayNumber}
              lang={lang}
              word={puzzle.word.word}
              placement={placement}
              animate={animateResults}
            />
          </div>
        )}
      </div>
    </div>
  );
}
