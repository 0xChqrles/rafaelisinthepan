import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { heatColor } from '@whippin/shared';
import type { BenchmarkResults } from '@whippin/shared';
import { bucketMeans, shareText, shareUrl } from '../game/share';
import { lineupModel, hasDisplayEntries } from '../game/benchmark';
import { BOT_KEYS, CHARACTER_PALETTES } from './teleportStrips';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import { track } from '../analytics';
import { t } from '../i18n';

// Reveal choreography (this component mounts after the last hole has settled): the result
// stack rises in, the score tallies (when the headline renders), then the neutral
// trajectory squares colorize in order.
const SQUARE_STAGGER_MS = 55;
const GRID_MAX_SPAN_MS = 1400;
export const RESULTS_IN_MS = 250; // mirrors .solved-results' transition duration in CSS
const SCORE_COUNT_MS = 800;
const NEUTRAL_HOLD_MS = SQUARE_STAGGER_MS;

// Sentence-specific results only. With displayed opponents (decided 2026-07-24, #110)
// the centerpiece is the LEADERBOARD TABLE — one row per entrant sorted by score
// (player ahead on a tie), each row an identity-colored tag, the run's bucketed heat
// squares (the opponent runs replayed by Game into `runSquares`), and the count (DNF
// muted) — it replaces BOTH the tries headline and the standalone squares row. Surfaces
// without opponents — the tutorial and benchmark-less puzzles — keep the classic stack:
// the named `<tries> TRIES` headline (their ONLY end-of-round count) and the single
// squares row. Player-level progression lives in StreakDialog, outside this layout.
// The tutorial reuses it with PLAY in SHARE's slot.
export default function SolvedScreen({
  guessCount,
  trajectory,
  dayNumber,
  lang,
  benchmark,
  runSquares,
  action,
  animate = true,
  startAnimation = true,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  dayNumber: number | null;
  lang: string; // packed into the share token (drives the link's click-through target)
  benchmark?: BenchmarkResults; // offline opponents; shown only on this solved surface
  runSquares?: Map<string, number[]>; // model id -> its replayed run's bucketed squares
  action?: { label: string; onClick: () => void }; // replaces SHARE in the tutorial
  // Rehydrated solves render their final result immediately. Fresh solves animate, with
  // startAnimation acting as the source/streak gate while this component stays mounted.
  animate?: boolean;
  // A live active-day solve holds this at false while StreakDialog is open. No-dialog
  // paths (archive, tutorial, and rehydration) use the immediate default.
  startAnimation?: boolean;
}) {
  // Collapse the per-guess trajectory into a bounded row (3..18), each square colored by
  // its bucket's mean progress. This exact array also drives the share card and emoji row.
  const squares = useMemo(() => bucketMeans(trajectory), [trajectory]);
  // Leaderboard rows (#110): every entrant sorted by score (lineupModel's order — the
  // player ahead on a tie, DNF last), wearing its lineup identity color, with its own
  // run's squares (the player's are the share-card squares; opponents' come replayed
  // from Game). null when no opponent displays.
  const rows = useMemo(() => {
    if (!hasDisplayEntries(benchmark)) return null;
    return lineupModel(benchmark as BenchmarkResults, guessCount, t(lang, 'you')).entrants.map(
      (e) => ({
        key: e.key,
        tag: e.tag,
        label: e.label,
        tries: e.tries,
        player: e.player,
        color: e.player ? 'var(--accent)' : CHARACTER_PALETTES[BOT_KEYS[e.sprite]].base,
        squares: e.player ? squares : (runSquares?.get(e.key) ?? []),
      }),
    );
  }, [benchmark, guessCount, lang, runSquares, squares]);
  // The leaderboard owns the count when opponents display; the headline renders without it.
  const showScore = rows === null;
  const n = squares.length;
  // The colorize wave walks square COLUMNS (shared delays per index), so on the
  // leaderboard it sweeps every row at once; span from the longest row present.
  const maxN = rows ? Math.max(...rows.map((r) => r.squares.length), 1) : n;
  const stagger = maxN > 1 ? Math.min(SQUARE_STAGGER_MS, GRID_MAX_SPAN_MS / (maxN - 1)) : 0;
  // No headline -> no tally beat: the squares start right after the stack has risen.
  const squaresStartMs = showScore ? RESULTS_IN_MS + SCORE_COUNT_MS : RESULTS_IN_MS;
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
  const gridSpanMs = Math.max(0, maxN - 1) * stagger;
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

  // "COPIED" confirmation after a clipboard fallback (the native share sheet needs none).
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onShare = useCallback(async () => {
    // The tutorial reuses this component with no real day (dayNumber null) and the PLAY
    // action instead of SHARE, so the share button is never rendered there.
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
    <div className={`solved-results${resultsIn ? ' in' : ''}`}>
      {/* The primary sentence metric — podium-less surfaces only (#110): with displayed
          opponents the standings podium above carries the count. The hidden final value
          reserves the count's width so its tally never moves the content below it. */}
      {showScore && (
        <span className="solved-score">
          <span className="solved-score-num">
            <span className="solved-score-ghost" aria-hidden="true">
              {guessCount}
            </span>
            <span className="solved-score-live">{Math.round(shownScore)}</span>
          </span>
          <span className="solved-score-unit">{t(lang, guessCount === 1 ? 'try' : 'tries')}</span>
        </span>
      )}

      {/* Decorative visual history of this sentence — the leaderboard table when
          opponents display (one row per entrant: identity tag, its run's squares, its
          count), the single squares row otherwise. The sr line below and the share text
          carry the accessible result; the player's bucket values are the SAME array
          encoded into the share card either way. */}
      {rows ? (
        <div className="leaderboard" aria-hidden="true">
          {rows.map((row) => (
            <Fragment key={row.key}>
              <span className="lb-tag" style={{ color: row.color }}>
                {row.tag}
              </span>
              <div
                className={`heat-grid lb-squares${gridShown ? ' shown' : ''}${
                  gridColorized ? ' colorized' : ''
                }`}
                style={{ '--n': row.squares.length } as CSSProperties}
              >
                {row.squares.map((pct, i) => (
                  <span
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                    className="heat-cell"
                    style={
                      {
                        '--cell-color': heatColor(pct / 100),
                        '--show-delay': `${Math.round(i * stagger)}ms`,
                        '--color-delay': `${Math.round(i * stagger)}ms`,
                      } as CSSProperties &
                        Record<'--cell-color' | '--show-delay' | '--color-delay', string>
                    }
                  />
                ))}
              </div>
              <span className={`lb-score${row.tries === null ? ' dnf' : ''}`}>
                {row.tries ?? t(lang, 'dnf')}
              </span>
            </Fragment>
          ))}
        </div>
      ) : (
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
      )}

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

      {/* The leaderboard table (#110) is the VISUAL final standings, but it is
          decorative (aria-hidden) — this line keeps the ranking accessible. */}
      {rows && (
        <p className="sr-only">
          {rows.map((row) => `${row.label} ${row.tries ?? t(lang, 'dnf')}`).join(' · ')}
        </p>
      )}
    </div>
  );
}
