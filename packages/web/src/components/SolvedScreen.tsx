import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { heatColor } from '@whippin/shared';
import type { BenchmarkEntry } from '@whippin/shared';
import { bucketMeans, shareText, shareUrl } from '../game/share';
import { benchmarkRanking } from '../game/benchmark';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import { track } from '../analytics';
import { t } from '../i18n';

// Reveal choreography (this component mounts after the last hole has settled): the result
// stack rises in, the score tallies, then the neutral trajectory squares colorize in order.
const SQUARE_STAGGER_MS = 55;
const GRID_MAX_SPAN_MS = 1400;
export const RESULTS_IN_MS = 350;
const SCORE_COUNT_MS = 800;
const SQUARES_START_MS = RESULTS_IN_MS + SCORE_COUNT_MS;
const NEUTRAL_HOLD_MS = SQUARE_STAGGER_MS;

// Sentence-specific results only: tries, the solve's progress trajectory, and its share
// action. Player-level progression lives in StreakDialog, outside this layout. Keeping the
// stack identical at every breakpoint gives the three result elements one stable hierarchy.
// The tutorial reuses it with PLAY in SHARE's slot.
export default function SolvedScreen({
  guessCount,
  trajectory,
  dayNumber,
  lang,
  benchmark,
  action,
  animate = true,
  startAnimation = true,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  dayNumber: number | null;
  lang: string; // packed into the share token (drives the link's click-through target)
  benchmark?: BenchmarkEntry[]; // offline opponents; shown only on this solved surface
  action?: { label: string; onClick: () => void }; // replaces SHARE in the tutorial
  // Rehydrated solves render their final result immediately. Fresh solves animate, with
  // startAnimation acting as the source/streak gate while this component stays mounted.
  animate?: boolean;
  // A live active-day solve holds this at false while StreakDialog is open. No-dialog
  // paths (archive, tutorial, override, and rehydration) use the immediate default.
  startAnimation?: boolean;
}) {
  // Collapse the per-guess trajectory into a bounded row (3..18), each square colored by
  // its bucket's mean progress. This exact array also drives the share card and emoji row.
  const squares = useMemo(() => bucketMeans(trajectory), [trajectory]);
  const ranking = useMemo(
    () =>
      benchmark === undefined
        ? null
        : benchmarkRanking(benchmark, guessCount, t(lang, 'you')),
    [benchmark, guessCount, lang],
  );
  const n = squares.length;
  const stagger = n > 1 ? Math.min(SQUARE_STAGGER_MS, GRID_MAX_SPAN_MS / (n - 1)) : 0;
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

  // After the score lands, reveal the neutral tiles and then color them cold-to-hot. The
  // row always reserves its final footprint, so neither animation moves the share action.
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
    const show = window.setTimeout(() => setGridShown(true), SQUARES_START_MS);
    const color = window.setTimeout(
      () => setGridColorized(true),
      SQUARES_START_MS + gridSpanMs + NEUTRAL_HOLD_MS,
    );
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(color);
    };
  }, [animate, gridSpanMs, reduceMotion, resultsIn]);

  // "COPIED" confirmation after a clipboard fallback (the native share sheet needs none).
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onShare = useCallback(async () => {
    // A ?puzzle= override has no real day to encode, so its share button is not rendered.
    if (dayNumber == null) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = shareUrl(origin, { lang, dayNumber, score: guessCount, squares });
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
  }, [lang, dayNumber, guessCount, squares]);

  return (
    <div
      className={`solved-results${ranking ? ' benchmarked' : ''}${resultsIn ? ' in' : ''}`}
    >
      {/* The primary sentence metric. The hidden final value reserves the count's width so
          its tally never moves the centered label or the content below it. */}
      <span className="solved-score">
        <span className="solved-score-num">
          <span className="solved-score-ghost" aria-hidden="true">
            {guessCount}
          </span>
          <span className="solved-score-live">{Math.round(shownScore)}</span>
        </span>
        <span className="solved-score-unit">{t(lang, guessCount === 1 ? 'try' : 'tries')}</span>
      </span>

      {/* Decorative visual history of this sentence. The named try count and share text carry
          the accessible result; the same bucket values are encoded into the share card. */}
      <div
        className={`heat-grid${gridShown ? ' shown' : ''}${gridColorized ? ' colorized' : ''}`}
        aria-hidden="true"
        style={{ '--n': n } as CSSProperties}
      >
        {squares.map((pct, i) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="heat-cell"
            style={
              {
                '--cell-color': heatColor(pct / 100),
                '--show-delay': `${Math.round(i * stagger)}ms`,
                '--color-delay': `${Math.round(i * stagger)}ms`,
              } as CSSProperties & Record<'--cell-color' | '--show-delay' | '--color-delay', string>
            }
          />
        ))}
      </div>

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

      {ranking && (
        <p className="benchmark-ranking">
          {ranking.map((entry, index) => (
            <span key={`${entry.player ? 'player' : 'model'}-${entry.label}-${index}`}>
              {index > 0 && <span className="benchmark-separator"> · </span>}
              <span className={entry.player ? 'benchmark-player' : 'benchmark-model'}>
                {entry.label} {entry.tries ?? t(lang, 'dnf')}
              </span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
