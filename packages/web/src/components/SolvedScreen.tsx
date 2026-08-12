import { useCallback, useEffect, useRef, useState } from 'react';
import { dateForDayNumber } from '@whippin/shared';
import { shareText, shareUrl } from '../game/share';
import RunRuler, { rulerStagger } from './RunRuler';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import useShare from '../hooks/useShare';
import { t } from '../i18n';
import { RESULTS_IN_MS, SCORE_COUNT_MS } from './resultAnimation';

// Reveal choreography (this component mounts after the last hole has settled): the result
// stack rises in, the score tallies, then the neutral run ruler colorizes in try order.
const NEUTRAL_HOLD_MS = 55;

// Sentence-specific results only. The tray is the SAME compact stack at every breakpoint
// and on every surface (decided 2026-07-25): the named `<tries> TRIES` headline, the
// PLAYER's run ruler, then SHARE. Player-level
// progression lives in StreakDialog, outside this layout. It belongs to a REAL solved day:
// the onboarding tutorial used to borrow it with a null `dayNumber` and PLAY in SHARE's
// slot, and stopped when its ending moved onto the route map (#155) — a lesson has no score
// to show, so it has no result screen either.
export default function SolvedScreen({
  guessCount,
  trajectory,
  solvedAt,
  dayNumber,
  lang,
  animate = true,
  startAnimation = true,
  onRisen,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  solvedAt?: (number | null)[]; // the player's solve moments (ruler ticks)
  dayNumber: number;
  lang: string; // packed into the share token (drives the link's click-through target)
  // Rehydrated solves render their final result immediately. Fresh solves animate, with
  // startAnimation acting as the source/streak gate while this component stays mounted.
  animate?: boolean;
  // A live active-day solve holds this at false while StreakDialog is open. No-dialog
  // paths (archive, tutorial, and rehydration) use the immediate default.
  startAnimation?: boolean;
  // Fires once when the animated rise-in has finished — the solved sequence's cue for
  // the SOURCE typewriter, its LAST beat (decided 2026-07-24). Never fires when
  // animate is false (rehydrated solves set their source states directly).
  onRisen?: () => void;
}) {
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const n = Math.max(trajectory.length, 1);
  const stagger = rulerStagger(n, reduceMotion);
  const rulerStartMs = RESULTS_IN_MS + SCORE_COUNT_MS;

  // Bring the whole result into place first, then tally its headline number. Keeping the
  // component mounted but inert lets the streak dialog own the screen without allowing
  // this sequence to finish invisibly underneath it.
  const [resultsIn, setResultsIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setResultsIn(true);
      return undefined;
    }
    if (!startAnimation) return undefined;
    const raf = requestAnimationFrame(() => setResultsIn(true));
    return () => cancelAnimationFrame(raf);
  }, [animate, startAnimation]);

  // Report the rise done exactly once per mount, RESULTS_IN_MS after it starts (at once
  // under reduced motion — the transition is collapsed but the beat still advances).
  const onRisenRef = useRef(onRisen);
  useEffect(() => {
    onRisenRef.current = onRisen;
  });
  useEffect(() => {
    if (!animate || !resultsIn) return undefined;
    if (reduceMotion) {
      onRisenRef.current?.();
      return undefined;
    }
    const id = window.setTimeout(() => onRisenRef.current?.(), RESULTS_IN_MS);
    return () => window.clearTimeout(id);
  }, [animate, resultsIn, reduceMotion]);

  const [countTarget, setCountTarget] = useState(() => (animate ? 0 : guessCount));
  useEffect(() => {
    if (!animate) {
      setCountTarget(guessCount);
      return undefined;
    }
    if (!resultsIn) return undefined;
    const id = window.setTimeout(() => setCountTarget(guessCount), reduceMotion ? 0 : RESULTS_IN_MS);
    return () => window.clearTimeout(id);
  }, [animate, resultsIn, guessCount, reduceMotion]);
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
    if (!resultsIn) return undefined;
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
  }, [animate, rulerSpanMs, reduceMotion, resultsIn, rulerStartMs]);

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
    <div className={`solved-results${resultsIn ? ' in' : ''}`}>
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
  );
}
