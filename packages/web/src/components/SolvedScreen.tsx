import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { dateForDayNumber, type Source } from '@whippin/shared';
import { prefersReducedMotion } from '../hooks/useScramble';
import { shareText, shareUrl } from '../game/share';
import type { ScorePlacement } from '../hooks/useScoreHistogram';
import RunRuler, { rulerStagger } from './RunRuler';
import ScoreChart from './ScoreChart';
import SolvedCaption from './SolvedCaption';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import useShare from '../hooks/useShare';
import { ariaHoleHistory, t } from '../i18n';
import { SCORE_COUNT_MS } from './resultAnimation';

// The sentence result, redesigned as the WHOLE screen (user-decided 2026-08-14): the
// dissolved sentence hands over the full play column, and the result reads in TWO
// BLOCKS, separated by a real seam (user-decided the same day) — first the PUZZLE, then
// the SCORE, because they answer different questions and running them together read as
// one undifferentiated column:
//
//   PUZZLE — the GUESSED WORDS in the solved blue, popping in one by one (each still a
//            button onto its own history line, with the ambient wave advertising the
//            tap), and the SOURCE typed under them at its own small caption size.
//   SCORE  — the named `<tries> TRIES` over its run ruler, the day's population chart,
//            and SHARE, which belongs to it (user-decided 2026-08-14: sharing is what
//            you do with a RESULT). The whole block sits on the screen's BOTTOM EDGE,
//            which is what turns the seam between the two into real space rather than a
//            measured gap — the taller the screen, the more the split reads.
//
// The reveal reads the same way it is laid out, top to bottom, off ONE derived timeline:
// every beat below is an absolute offset from the stage's arrival, so nothing waits on a
// signal that could be lost and a long citation cannot hold the numbers back.
// Rehydrated solves render the final frame immediately and replay nothing.
const NEUTRAL_HOLD_MS = 55;
// The words POP in one by one: 200ms apart, each a fast scale pop — the round's three
// trophies arriving, counted out. Fast and ONE-SHOT, which is the only form a scale may
// take on the pixel font (the rank exponent's `rank-pop` and the tally's `score-land`,
// same reasoning): a long scale TRANSITION renders blurry intermediate frames for its
// whole length, a 300ms hop lands before the eye can read one.
const WORD_STEP_MS = 200;
const WORD_POP_MS = 300;
// The score block follows the source's FIRST line, not its last character.
const CAPTION_LEAD_MS = 420;

// The ambient wave (#129), restated for the solved words the way WordSubject restates it
// for the day's word: importing half of Hole's internals is not sharing it. Same numbers,
// same CSS animation, same "several clocks, wide random band" reasoning.
const WAVE_LETTER_MS = 300;
const WAVE_STEP_MS = 40;
const WAVE_MIN_MS = 3_000;
const WAVE_MAX_MS = 10_000;

interface SolvedWordEntry {
  word: string; // the accented secret, as the sentence displayed it
  holeIndex: number; // the FIRST hole carrying this secret (the history modal's key)
  number: number; // 1-based distinct-secret position — the ruler ticks' own numbering
}

// One guessed word: a button named by its own content (the hole-button rule — the word IS
// what it shows), described by the sr hint, opening the history line it walked. Its
// letters ripple on the word's own clock while the screen is idle — the same affordance
// the holes wore, saying the same thing: this word can be tapped.
function SolvedWord({
  entry,
  shown,
  onExplore,
}: {
  entry: SolvedWordEntry;
  shown: boolean;
  onExplore: (holeIndex: number) => void;
}) {
  const letters = Array.from(entry.word);
  const [waving, setWaving] = useState(false);
  const [waveCount, setWaveCount] = useState(0);

  useEffect(() => {
    if (!shown || waving || prefersReducedMotion()) return undefined;
    const id = window.setTimeout(
      () => setWaving(true),
      WAVE_MIN_MS + Math.random() * (WAVE_MAX_MS - WAVE_MIN_MS),
    );
    return () => window.clearTimeout(id);
  }, [shown, waving, waveCount]);

  useEffect(() => {
    if (!waving) return undefined;
    const id = window.setTimeout(() => {
      setWaving(false);
      setWaveCount((n) => n + 1);
    }, WAVE_LETTER_MS + Math.max(0, letters.length - 1) * WAVE_STEP_MS);
    return () => window.clearTimeout(id);
    // Letter count is fixed for the word's lifetime; read when the wave starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waving]);

  const waveStyle: CSSProperties & Record<string, string> = {};
  if (waving) {
    waveStyle['--wave-dur'] = `${WAVE_LETTER_MS}ms`;
    waveStyle['--wave-step'] = `${WAVE_STEP_MS}ms`;
  }

  return (
    <button
      type="button"
      className={`solved-word${shown ? ' in' : ''}`}
      style={{ '--step': entry.number - 1 } as CSSProperties}
      aria-describedby={`solved-explore-${entry.number}`}
      data-hole-explore={entry.holeIndex}
      onClick={() => onExplore(entry.holeIndex)}
    >
      <span className="solved-word-num" aria-hidden="true">
        {entry.number}
      </span>
      {/* The wrap is what the history modal zooms out of (Game.openHistory measures it),
          exactly as it measured a hole's word. */}
      <span className="hole-word-wrap">
        <span className={`solved-word-text${waving ? ' wave' : ''}`} style={waveStyle}>
          {letters.map((ch, i) => (
            <span key={i} className="hole-letter" style={{ '--i': i } as CSSProperties}>
              {ch}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

export default function SolvedScreen({
  guessCount,
  trajectory,
  solvedAt,
  dayNumber,
  lang,
  source,
  words,
  onExplore,
  placement = null,
  animate = true,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  solvedAt?: (number | null)[]; // the player's solve moments (ruler ticks)
  dayNumber: number;
  lang: string; // packed into the share token (drives the link's click-through target)
  source?: Source;
  words: SolvedWordEntry[]; // distinct secrets, sentence order — the ruler ticks' numbering
  onExplore: (holeIndex: number) => void;
  // The day's score population (#170); null renders the reserved empty slot (silent).
  placement?: ScorePlacement | null;
  // Rehydrated solves render their final result immediately and replay nothing.
  animate?: boolean;
}) {
  const reduceMotion = prefersReducedMotion();
  const n = Math.max(trajectory.length, 1);
  const stagger = rulerStagger(n, reduceMotion);
  const hasSource = Boolean(source?.kind || source?.author || source?.work);

  // The ONE derived timeline (see the block comment): the words count themselves out,
  // the source follows the last of them, and the score block arrives after the seam.
  const wordsSpanMs = words.length ? (words.length - 1) * WORD_STEP_MS + WORD_POP_MS : 0;
  const scoreStartMs = wordsSpanMs + (hasSource ? CAPTION_LEAD_MS : 140);
  const rulerStartMs = scoreStartMs + SCORE_COUNT_MS;

  // The stage rises once; every block's own beat hangs off this one flip.
  const [stageIn, setStageIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setStageIn(true);
      return undefined;
    }
    const raf = requestAnimationFrame(() => setStageIn(true));
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  // The words need no beat of their own: they pop the moment the stage is up, and CSS
  // counts them out from each word's own index (`--step`).
  const wordsIn = !animate || stageIn;

  // The source types once the last word has landed; its completion only retires its own
  // cursor — nothing downstream waits on it.
  const [captionDone, setCaptionDone] = useState(false);
  const finishCaption = useCallback(() => setCaptionDone(true), []);
  const [captionIn, setCaptionIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setCaptionIn(true);
      return undefined;
    }
    if (!stageIn) return undefined;
    const id = window.setTimeout(() => setCaptionIn(true), reduceMotion ? 0 : wordsSpanMs);
    return () => window.clearTimeout(id);
  }, [animate, stageIn, reduceMotion, wordsSpanMs]);

  // The SCORE block: the seam's other side. Its arrival is what starts the tally, so the
  // number never counts behind a block that has not appeared yet.
  const [scoreIn, setScoreIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setScoreIn(true);
      return undefined;
    }
    if (!stageIn) return undefined;
    const id = window.setTimeout(() => setScoreIn(true), reduceMotion ? 0 : scoreStartMs);
    return () => window.clearTimeout(id);
  }, [animate, stageIn, reduceMotion, scoreStartMs]);

  const [countTarget, setCountTarget] = useState(() => (animate ? 0 : guessCount));
  useEffect(() => {
    if (scoreIn) setCountTarget(guessCount);
  }, [scoreIn, guessCount]);
  const shownScore = useAnimatedNumber(countTarget, !animate || reduceMotion ? 1 : SCORE_COUNT_MS);

  // After the score lands, reveal the neutral cells and then color them in try order.
  // The ruler always reserves its final footprint, so neither animation moves the
  // actions below it.
  const rulerSpanMs = Math.max(0, n - 1) * stagger;
  const [rulerShown, setRulerShown] = useState(() => !animate);
  const [rulerColorized, setRulerColorized] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setRulerShown(true);
      setRulerColorized(true);
      return undefined;
    }
    if (!stageIn) return undefined;
    if (reduceMotion) {
      setRulerShown(true);
      setRulerColorized(true);
      return undefined;
    }
    const show = window.setTimeout(() => setRulerShown(true), rulerStartMs);
    const color = window.setTimeout(
      () => setRulerColorized(true),
      rulerStartMs + rulerSpanMs + NEUTRAL_HOLD_MS,
    );
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(color);
    };
  }, [animate, rulerSpanMs, reduceMotion, stageIn, rulerStartMs]);

  // The population chart HEADS the score block since 2026-08-15, so it arrives WITH it —
  // the reveal reads the way the stage is laid out, top to bottom, and a column that sits
  // above the tally must not land after it. Its own internal beat still runs crowd-first,
  // gold-after (see ScoreChart). The chart holds its layout slot from the start, so this
  // changes when it appears, never where anything sits.
  const chartStart = scoreIn;

  // Delivery (native sheet / clipboard + the "COPIED" confirmation) is the shared hook's;
  // this screen only composes the sentence result's text.
  const { share, copied } = useShare();

  const onShare = useCallback(async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = shareUrl(origin, {
      lang,
      dayNumber,
      score: guessCount,
      trajectory,
      solvedAt: solvedAt ?? [],
    });
    const unit = t(lang, guessCount === 1 ? 'try' : 'tries').toLowerCase();
    // The day is named by its CALENDAR DATE, not the internal day index (decided
    // 2026-08-03): a reader can date the sentence, and it is the same string the card
    // draws and the shared link resolves to. dateForDayNumber is dayNumber's exact
    // inverse, so this is still the server-owned game day, not the sharer's local date.
    const headline = `Whippin AI ${dateForDayNumber(dayNumber)} — ${guessCount} ${unit}`;
    // The card (via the token) draws the run in full; the plain-text row is the bounded
    // summary of that SAME run — trajectory and solve moments both — so the link and its
    // fallback can't disagree.
    await share(shareText(headline, trajectory, solvedAt ?? [], url));
  }, [lang, dayNumber, guessCount, trajectory, solvedAt, share]);

  return (
    <div className={`solved-stage${stageIn ? ' in' : ''}${animate ? '' : ' settled'}`}>
      {/* ---- the PUZZLE block: what the round was about. Its auto margins take the
           leftover height, which centres it above the score block and pins that block
           to the bottom edge. */}
      <div className="solved-puzzle">
        {/* The found words — the round's trophies, and still its buttons: each opens the
            history line it walked, numbered as the ruler's ticks number them. They pop
            in one by one; CSS counts them out off each word's own `--step`. */}
        <div className="solved-words">
          {words.map((entry) => (
            <SolvedWord key={entry.number} entry={entry} shown={wordsIn} onExplore={onExplore} />
          ))}
        </div>
        {words.map((entry) => (
          <span key={entry.number} id={`solved-explore-${entry.number}`} className="sr-only">
            {ariaHoleHistory(lang, entry.number)}
          </span>
        ))}

        {/* The sentence's attribution, UNDER the words it belongs to and at its own
            caption size — the small quote-style citation it has always been. A
            source-less puzzle simply shows the words. */}
        {hasSource && (
          <div className={`solved-source${captionIn ? ' in' : ''}`}>
            <SolvedCaption
              source={source}
              animate={animate && captionIn && !captionDone}
              onComplete={finishCaption}
            />
          </div>
        )}
      </div>

      {/* ---- the SCORE block, on the bottom edge: how the round went, and what you do
           with it. */}
      <div className={`solved-numbers${scoreIn ? ' in' : ''}`}>
        {/* Where this run sits among the day's players (#170) — the crowd first, then
            YOUR number and the run that made it, so SHARE ends up next to exactly what
            the card it shares draws (user-decided 2026-08-15). Always mounted: the slot
            reserves its footprint, so the chart arriving — or never arriving, on a silent
            failure — moves nothing under it. */}
        <ScoreChart
          placement={placement}
          mode="sentence"
          lang={lang}
          animate={animate}
          start={chartStart}
        />

        {/* The primary sentence metric. The hidden final value reserves the count's width
            so its tally never moves the content below it. */}
        <span className="solved-score">
          <span className="solved-score-num">
            <span className="solved-score-ghost" aria-hidden="true">
              {guessCount}
            </span>
            <span className="solved-score-live">{Math.round(shownScore)}</span>
          </span>
          <span className="solved-score-unit">{t(lang, guessCount === 1 ? 'try' : 'tries')}</span>
        </span>

        {/* The player's own run ruler — the share card draws this same ruler from the v2
            token. */}
        <div className="run-ruler-frame" aria-hidden="true">
          <RunRuler
            trajectory={trajectory}
            solvedAt={solvedAt ?? []}
            stagger={stagger}
            shown={rulerShown}
            colorized={rulerColorized}
          />
        </div>

        <div className="result-actions">
          <button
            type="button"
            className={`result-action${copied ? ' copied' : ''}`}
            onClick={onShare}
          >
            {copied ? t(lang, 'copied') : t(lang, 'share')}
          </button>
        </div>
      </div>
    </div>
  );
}
