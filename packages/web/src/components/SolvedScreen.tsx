import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { bucketMeans, shareText, shareUrl } from '../game/share';
import { heatColor } from '@whippin/shared';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import useToday from '../hooks/useToday';
import { useGameStore } from '../state/gameStore';
import { currentStreak, weekView, type WeekCell } from '../game/streak';
import { track } from '../analytics';
import { t } from '../i18n';
// The hero streak flame is a 32×32 pixel-art sprite (raster PNG, rendered at its NATIVE
// 32px so it stays crisp — pixel art only scales cleanly by integer factors). The small
// weekly-day marks stay the simple inline SVG flame (currentColor, crisp at any size) — a
// detailed hero + simpler repeated marks is the intended pattern (#74).
import streakFlame from '../assets/streak.png';
import FlameSmall from '../assets/icons/flame.svg?react';

// Stable empty reference so the zustand selector below never returns a fresh array (which
// would churn renders) when a language has no solved days yet.
const NO_SOLVED_DAYS: number[] = [];

// Reveal choreography (this component MOUNTS at the reveal moment — Game gates it on the last
// hole's solve animation finishing, so the animations below ARE the reveal): the score/share
// row fades in and the score tallies up from 0, THEN the heat squares appear as neutral
// surface tiles and colorize one by one. Score first (the headline), heat trail after.
const SQUARE_STAGGER_MS = 55; // gap between consecutive squares colorizing...
const GRID_MAX_SPAN_MS = 1400; // ...compressed so even a long game's grid stays snappy
const ACTIONS_IN_MS = 350; // score+share fade/rise into place (matches .solved-actions transition)
const SCORE_COUNT_MS = 800; // score tally 0 -> guessCount
// The uncolored squares appear only AFTER the score is shown (row settled + tally finished)...
const SQUARES_START_MS = ACTIONS_IN_MS + SCORE_COUNT_MS;
const NEUTRAL_HOLD_MS = SQUARE_STAGGER_MS; // ...are held neutral this long, THEN colorize one by one.

// The solved results (issue #8): it takes over the on-screen keyboard's footprint once
// the sentence is solved, so the layout never reflows and no empty gap is left where the
// keyboard was. Understated + flat to match the app: a heat-grid of one pixel square per
// counted guess (colored by the game's own heat ramp — cold/far to hot/solved), the
// score, and a share control styled like a keyboard key. Reused by the already-solved
// screen (#9) and by the tutorial's ending (#51), which swaps SHARE for its own
// `action` (PLAY) so the tutorial graduates into the EXACT solved layout of the real
// game. The reconstructed sentence + attribution live above, in <SolvedCaption>.
export default function SolvedScreen({
  guessCount,
  trajectory,
  dayNumber,
  lang,
  isActiveDay = true,
  action,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  dayNumber: number | null;
  lang: string; // packed into the share token (drives the link's click-through target)
  // Whether the solved day is the client's active day. The "NEXT PUZZLE IN" countdown is
  // a statement about TODAY, so it is hidden when replaying a past archive day (#55).
  isActiveDay?: boolean;
  action?: { label: string; onClick: () => void }; // replaces the SHARE control (tutorial)
}) {
  // Collapse the per-guess trajectory into a bounded set of squares (3..18), each colored
  // by its bucket's mean progress. Same array drives the on-screen grid and the share row.
  const squares = useMemo(() => bucketMeans(trajectory), [trajectory]);
  const n = squares.length;
  // Per-square stagger, compressed for long games so the whole grid lands within a bound.
  const stagger = n > 1 ? Math.min(SQUARE_STAGGER_MS, GRID_MAX_SPAN_MS / (n - 1)) : 0;

  // Reveal in three beats: (1) the score+share row fades/rises into place, (2) the score
  // tallies up from 0 in its final position, and only THEN (3) the squares pop in one by one
  // (their staggered CSS delays are offset by SQUARES_START_MS, below). Score first, squares
  // after — the score is the headline, the heat trail the follow-up.
  const [countTarget, setCountTarget] = useState(0);
  const [showActions, setShowActions] = useState(false);
  // (1) On mount (the reveal moment), bring the row in on the next frame so its fade/rise
  //     transition actually plays.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShowActions(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  // (2) Once the row has settled into position, start the score tally from 0.
  useEffect(() => {
    if (!showActions) return undefined;
    const t = window.setTimeout(() => setCountTarget(guessCount), ACTIONS_IN_MS);
    return () => window.clearTimeout(t);
  }, [showActions, guessCount]);
  const shownScore = useAnimatedNumber(countTarget, SCORE_COUNT_MS);

  // (3) After the score is shown: neutral tiles roll in one by one (gridShown + per-cell
  //     --show-delay), and once they are all in (+ a brief hold) each colorizes one by one
  //     (gridColorized + per-cell --color-delay). Two class flips on .heat-grid drive the
  //     CSS transitions. gridSpanMs = how long the staggered wave takes end to end.
  const gridSpanMs = Math.max(0, n - 1) * stagger;
  const [gridShown, setGridShown] = useState(false);
  const [gridColorized, setGridColorized] = useState(false);
  useEffect(() => {
    const show = window.setTimeout(() => setGridShown(true), SQUARES_START_MS);
    const color = window.setTimeout(
      () => setGridColorized(true),
      SQUARES_START_MS + gridSpanMs + NEUTRAL_HOLD_MS,
    );
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(color);
    };
  }, [gridSpanMs]);

  // Streak (#56/#74): derived from the per-language solved-day SET, never a stored counter.
  // Shown only for a streak-eligible solve — an active-day win with a real dayNumber. An
  // archive replay (isActiveDay false) or a ?puzzle= override (dayNumber null) shows none;
  // and a 0 guards the pre-feature rehydration whose day predates the set (a real fresh
  // solve is always >= 1, since recordSolve added today before this screen reveals).
  const solvedDays = useGameStore((s) => s.solvedDays[lang] ?? NO_SOLVED_DAYS);
  const activeDay = useToday();
  const streak = currentStreak(solvedDays, activeDay);
  const showStreak = dayNumber != null && isActiveDay && streak > 0;
  // The Monday-based weekly row is shown only on a "clean week so far" (#74).
  const week = useMemo(() => weekView(solvedDays, activeDay), [solvedDays, activeDay]);

  // "COPIED" confirmation after a clipboard fallback (the native share sheet needs none).
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const onShare = useCallback(async () => {
    // No server day (a ?puzzle= override) -> no share: the token has no real dayNumber
    // to carry (the codec would clamp it to a bogus id). The button isn't rendered then;
    // this guard just makes the invariant local.
    if (dayNumber == null) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    // The result is packed into the link; the backend renders /s/<token> as the OG card, so
    // sharing the URL unfurls into the image.
    const url = shareUrl(origin, { lang, dayNumber, score: guessCount, squares });
    // What we share/copy: a headline line, then the heat-square emoji row (the plain-text
    // fallback for the OG card — same `squares`, so they can't disagree), a blank line, then
    // the (unfurling) link. "N tries" (not a bare number): lower-is-better must survive
    // without the card. Localized like the rest of the chrome — a French result reads "essais".
    const unit = t(lang, guessCount === 1 ? 'try' : 'tries').toLowerCase();
    const headline = `Whippin #${dayNumber} — ${guessCount} ${unit}`;
    const text = shareText(headline, squares, url);

    // Use the Web Share API only on touch/mobile devices (native share sheet). On DESKTOP
    // the share button should just copy the link — desktop Chrome/Edge/Safari expose
    // navigator.share too, so gate on the device (coarse pointer), not the API's presence.
    // Fall back to the clipboard everywhere else, matching the "copy to clipboard" default.
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
        if ((err as DOMException)?.name === 'AbortError') return; // user dismissed the sheet
        // any other failure -> fall through to the clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      track('share', { method: 'clipboard' });
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied): nothing more we can do here.
    }
  }, [lang, dayNumber, guessCount, squares]);

  return (
    <div className="solved-results">
      {/* Streak (#56/#74): the flame + STREAK n line and, on a clean week, the bigger
          Duolingo-style 7-day row — at the TOP; the heat squares stay grouped with the
          score/share below, as they describe the same result (decided 2026-07-09). Rides
          the shared fade/rise. Only for a streak-eligible solve (active day, real
          dayNumber); an archive replay and a ?puzzle= override show none. */}
      {showStreak && (
        <div className={`streak-block${showActions ? ' in' : ''}`}>
          {/* Duolingo-style: the big flame + count are the headline, the small "DAY STREAK"
              label sits under them. SR reads "3 DAY STREAK"; the flame is decorative. */}
          <div className="streak-headline">
            <div className="streak-head">
              <img className="streak-flame" src={streakFlame} width={96} height={96} alt="" aria-hidden />
              <span className="streak-count">{streak}</span>
            </div>
            <p className="streak-label">{t(lang, 'dayStreak')}</p>
          </div>
          {week.clean && <WeekRow cells={week.cells} lang={lang} />}
        </div>
      )}

      {/* One flat square per bucket (3..18). AFTER the score is shown, neutral surface tiles
          roll in one by one (.shown + staggered --show-delay), then each colorizes to its
          bucket's MEAN reconstruction % one by one (.colorized + staggered --color-delay).
          heatColor: 0 = cold/far crimson .. 1 = hot/solved cyan — the same ramp as the
          rank exponents and the share card. Decorative — the score/share carry the real
          numbers. The grid keeps its height throughout, so nothing shifts. */}
      <div
        className={`heat-grid${gridShown ? ' shown' : ''}${gridColorized ? ' colorized' : ''}`}
        aria-hidden="true"
        // --n (square count) sizes the row so it hugs its content and never wraps (see CSS).
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

      <div className={`solved-actions${showActions ? ' in' : ''}`}>
        {/* "45 TRIES", not "SCORE 45": the count is the number of guesses, and naming the
            unit is what tells a reader (especially of the shared card) that LOWER is
            better — "SCORE" alone reads as points to maximize. */}
        <span className="solved-score">
          {/* Reserve the FINAL count's exact width with a hidden ghost (same font, letter-
              spacing and all), then overlay the live tally right-aligned on top — so the
              number counting 0 -> guessCount never changes width (9 -> 10 stays put). */}
          <span className="solved-score-num">
            <span className="solved-score-ghost" aria-hidden="true">
              {guessCount}
            </span>
            <span className="solved-score-live">{Math.round(shownScore)}</span>
          </span>{' '}
          {t(lang, guessCount === 1 ? 'try' : 'tries')}
        </span>
        {action ? (
          <button type="button" className="share-key" onClick={action.onClick}>
            {action.label}
          </button>
        ) : (
          dayNumber != null && (
            <button type="button" className={`share-key${copied ? ' copied' : ''}`} onClick={onShare}>
              {copied ? t(lang, 'copied') : t(lang, 'share')}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// Monday-first narrow weekday initials, localized (en: M T W T F S S; fr: L M M J V S D).
// Generated via Intl like the archive's weekday header, but FORCED to a Monday start — the
// weekly row is Monday-based for every language (decided 2026-07-08), not the locale's own
// first day. 2024-01-01 is a Monday, so offset it 0..6 (UTC, to match the date math).
function mondayNarrowLabels(lang: string): string[] {
  const fmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

// The Monday-based weekly streak row (#74), Duolingo-style: the 7 days Mon..Sun of the
// current week, shown only on a clean week (see weekView). DECORATIVE (aria-hidden) — the
// streak line above already announces the count, same rationale as the heat grid. A solved
// day shows the small flame; today is emphasized; future + pre-start days stay empty.
function WeekRow({ cells, lang }: { cells: WeekCell[]; lang: string }) {
  const labels = useMemo(() => mondayNarrowLabels(lang), [lang]);
  return (
    <div className="week-row" aria-hidden="true">
      {cells.map((c, i) => (
        <div
          key={c.dayNumber}
          className={
            'week-cell' +
            (c.solved ? ' solved' : '') +
            (c.isToday ? ' today' : '') +
            (c.isFuture ? ' future' : '')
          }
        >
          <span className="week-label">{labels[i]}</span>
          <span className="week-mark">{c.solved && <FlameSmall className="week-flame" />}</span>
        </div>
      ))}
    </div>
  );
}
