import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BenchmarkResults } from '@whippin/shared';
import { bucketMeans, shareText, shareUrl } from '../game/share';
import { lineupModel, hasDisplayEntries } from '../game/benchmark';
import RunRuler, { rulerStagger, type RunReplay } from './RunRuler';
import LeaderboardDialog, { type LeaderboardRow } from './LeaderboardDialog';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import { track } from '../analytics';
import { t } from '../i18n';

// Reveal choreography (this component mounts after the last hole has settled): the result
// stack rises in, the score tallies, then the neutral run ruler colorizes in try order.
export const RESULTS_IN_MS = 250; // mirrors .solved-results' transition duration in CSS
const SCORE_COUNT_MS = 800;
const NEUTRAL_HOLD_MS = 55;

// Sentence-specific results only. The tray is the SAME compact stack at every breakpoint
// and on every surface (decided 2026-07-25, superseding #110's inline leaderboard): the
// named `<tries> TRIES` headline, the PLAYER's run ruler, then the actions — SHARE plus,
// when displayed opponents exist, SEE MORE opening the full-screen LeaderboardDialog
// (the race lives there, with room to grow into #82's deeper views). Player-level
// progression lives in StreakDialog, outside this layout. The tutorial reuses it with
// PLAY in SHARE's slot (no opponents → no SEE MORE).
export default function SolvedScreen({
  guessCount,
  trajectory,
  solvedAt,
  dayNumber,
  lang,
  benchmark,
  runReplays,
  action,
  animate = true,
  startAnimation = true,
  onRisen,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  solvedAt?: (number | null)[]; // the player's solve moments (ruler ticks)
  dayNumber: number | null;
  lang: string; // packed into the share token (drives the link's click-through target)
  benchmark?: BenchmarkResults; // offline opponents; shown only on this solved surface
  runReplays?: Map<string, RunReplay>; // model id -> its replayed run
  action?: { label: string; onClick: () => void }; // replaces SHARE in the tutorial
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
  // The share TEXT keeps the BOUNDED bucketed row (3..18, mean progress per bucket) — emoji
  // can't draw a per-try ruler, let alone its ticks. The share CARD gets the raw run instead
  // (v2 token, decided 2026-07-25), so the unfurled image is this same ruler.
  const squares = useMemo(() => bucketMeans(trajectory), [trajectory]);
  // Leaderboard rows for the dialog (#110/#82): every entrant sorted by score
  // (lineupModel's order — the player ahead on a tie, DNF last), with its own replayed
  // run (opponents' come replayed from Game). null when no opponent displays.
  const rows = useMemo<LeaderboardRow[] | null>(() => {
    if (!hasDisplayEntries(benchmark)) return null;
    return lineupModel(benchmark as BenchmarkResults, guessCount, t(lang, 'you')).entrants.map(
      (e) => ({
        key: e.key,
        tag: e.tag,
        label: e.label,
        tries: e.tries,
        player: e.player,
        trajectory: e.player ? trajectory : (runReplays?.get(e.key)?.trajectory ?? []),
        solvedAt: e.player ? (solvedAt ?? []) : (runReplays?.get(e.key)?.solvedAt ?? []),
      }),
    );
  }, [benchmark, guessCount, lang, runReplays, trajectory, solvedAt]);
  const n = Math.max(trajectory.length, 1);
  const stagger = rulerStagger(n);
  const squaresStartMs = RESULTS_IN_MS + SCORE_COUNT_MS;
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  // After the score lands, reveal the neutral tiles and then color them in try order.
  // The ruler always reserves its final footprint, so neither animation moves the
  // actions below it.
  const gridSpanMs = Math.max(0, n - 1) * stagger;
  const [gridShown, setGridShown] = useState(() => !animate);
  const [gridColorized, setGridColorized] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setGridShown(true);
      setGridColorized(true);
      return undefined;
    }
    if (!resultsIn) return undefined;
    if (reduceMotion) {
      setGridShown(true);
      setGridColorized(true);
      return undefined;
    }
    const show = window.setTimeout(() => setGridShown(true), squaresStartMs);
    const color = window.setTimeout(
      () => setGridColorized(true),
      squaresStartMs + gridSpanMs + NEUTRAL_HOLD_MS,
    );
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(color);
    };
  }, [animate, gridSpanMs, reduceMotion, resultsIn, squaresStartMs]);

  // The SEE MORE leaderboard modal; closing returns focus to its trigger.
  const [lbOpen, setLbOpen] = useState(false);
  const seeMoreRef = useRef<HTMLButtonElement>(null);
  const closeLeaderboard = useCallback(() => {
    setLbOpen(false);
    seeMoreRef.current?.focus({ preventScroll: true });
  }, []);

  // "COPIED" confirmation after a clipboard fallback (the native share sheet needs none).
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onShare = useCallback(async () => {
    // The tutorial reuses this component with no real day (dayNumber null) and the PLAY
    // action instead of SHARE, so the share button is never rendered there.
    if (dayNumber == null) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = shareUrl(origin, {
      lang,
      dayNumber,
      score: guessCount,
      trajectory,
      solvedAt: solvedAt ?? [],
    });
    const unit = t(lang, guessCount === 1 ? 'try' : 'tries').toLowerCase();
    const headline = `Whippin #${dayNumber} — ${guessCount} ${unit}`;
    const text = shareText(headline, squares, url);

    // Touch devices get their native share sheet; desktop copies the result directly.
    const isTouch =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    if (isTouch && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Whippin AI', text });
        track('share', { method: 'native' });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        // Any other native-share failure falls through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      track('share', { method: 'clipboard' });
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied): there is no further browser fallback.
    }
  }, [lang, dayNumber, guessCount, squares, trajectory, solvedAt]);

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
          token. The race against the models lives behind SEE MORE (LeaderboardDialog). */}
      <div className="run-ruler-frame" aria-hidden="true">
        <RunRuler
          trajectory={trajectory}
          solvedAt={solvedAt ?? []}
          maxN={n}
          stagger={stagger}
          shown={gridShown}
          colorized={gridColorized}
          solo
        />
      </div>

      <div className="result-actions">
        {action ? (
          <button type="button" className="result-action" onClick={action.onClick}>
            {action.label}
          </button>
        ) : (
          dayNumber != null && (
            <button
              type="button"
              className={`result-action${copied ? ' copied' : ''}`}
              onClick={onShare}
            >
              {copied ? t(lang, 'copied') : t(lang, 'share')}
            </button>
          )
        )}
        {rows && (
          <button
            type="button"
            ref={seeMoreRef}
            className="result-action"
            onClick={() => setLbOpen(true)}
          >
            {t(lang, 'seeMore')}
          </button>
        )}
      </div>

      {/* The ranking stays accessible without opening the modal. */}
      {rows && (
        <p className="sr-only">
          {rows.map((row, i) => `${i + 1}. ${row.label} ${row.tries ?? t(lang, 'dnf')}`).join(' · ')}
        </p>
      )}

      {rows && lbOpen && <LeaderboardDialog rows={rows} lang={lang} onClose={closeLeaderboard} />}
    </div>
  );
}
