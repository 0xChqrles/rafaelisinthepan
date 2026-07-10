import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bucketMeans, shareText, shareUrl } from '../game/share';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import useToday from '../hooks/useToday';
import { useGameStore } from '../state/gameStore';
import { currentStreak, weekView, type WeekCell } from '../game/streak';
import { track } from '../analytics';
import { t } from '../i18n';
// The hero flame is TWO stacked animated 6-frame sprite sheets — the flame core over a
// glow layer whose opacity breathes independently — played entirely in CSS (.streak-flame
// pseudo-elements walked by steps(6), same technique as the calendar ripple), so it needs
// no JS asset import here. The weekly-day marks are plain flat squares (CSS only) — a
// detailed hero + minimal repeated marks (#74).

// Stable empty reference so the zustand selector below never returns a fresh array (which
// would churn renders) when a language has no solved days yet.
const NO_SOLVED_DAYS: number[] = [];

// Reveal choreography (this component MOUNTS at the reveal moment — Game gates it on the last
// hole's solve animation finishing, so the animations below ARE the reveal): the streak block
// and score/share row fade in together, then the score tallies up from 0.
const ACTIONS_IN_MS = 350; // a group's fade/rise into place (matches the CSS transition)
const SCORE_COUNT_MS = 800; // score tally 0 -> guessCount
const STREAK_COUNT_MS = 800; // streak count tally 0 -> streak (same duration as the score)
// The score/share group enters this long AFTER the streak block (sequenced introduction:
// streak first, then the result) — as the streak tally is landing. 0 when there is no
// streak block, so a streak-less reveal is as immediate as before.
const ACTIONS_DELAY_MS = 700;

// The solved results (issue #8): it takes over the on-screen keyboard's footprint once
// the sentence is solved, so the layout never reflows and no empty gap is left where the
// keyboard was. Understated + flat to match the app: the streak block (#74), the score,
// and a share control styled like a keyboard key. The per-guess heat squares live ONLY in
// the share preview now (OG card + emoji row — decided 2026-07-10): on screen their 3..18
// variable width fought the fixed-width streak block, and they duplicated the card.
// Reused by the already-solved screen (#9) and by the tutorial's ending (#51), which swaps
// SHARE for its own `action` (PLAY) so the tutorial graduates into the EXACT solved layout
// of the real game. The reconstructed sentence + attribution live above, in <SolvedCaption>.
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
  // by its bucket's mean progress. Share-only now: it drives the OG card + the emoji row
  // of the share text (the on-screen grid was removed — see the component comment).
  const squares = useMemo(() => bucketMeans(trajectory), [trajectory]);

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

  // SEQUENCED reveal (this component mounts at the reveal moment): the streak block rises
  // first and its count tallies; the score/share group follows ACTIONS_DELAY_MS later and
  // its score tallies in turn. Without a streak block the group enters immediately.
  const [streakIn, setStreakIn] = useState(false);
  const [showActions, setShowActions] = useState(false);
  useEffect(() => {
    let delay: number | undefined;
    // Next frame, so the first group's fade/rise transition actually plays.
    const raf = requestAnimationFrame(() => {
      setStreakIn(true);
      delay = window.setTimeout(() => setShowActions(true), showStreak ? ACTIONS_DELAY_MS : 0);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(delay);
    };
  }, [showStreak]);

  // Each number starts tallying once its own group has settled into place (ACTIONS_IN_MS
  // after that group's rise begins). Ghost spans reserve the final widths, so neither
  // tally reflows its group.
  const [streakTarget, setStreakTarget] = useState(0);
  useEffect(() => {
    if (!streakIn || !showStreak) return undefined;
    const id = window.setTimeout(() => setStreakTarget(streak), ACTIONS_IN_MS);
    return () => window.clearTimeout(id);
  }, [streakIn, showStreak, streak]);
  const shownStreak = useAnimatedNumber(streakTarget, STREAK_COUNT_MS);

  const [countTarget, setCountTarget] = useState(0);
  useEffect(() => {
    if (!showActions) return undefined;
    const t = window.setTimeout(() => setCountTarget(guessCount), ACTIONS_IN_MS);
    return () => window.clearTimeout(t);
  }, [showActions, guessCount]);
  const shownScore = useAnimatedNumber(countTarget, SCORE_COUNT_MS);

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
      {/* Streak (#56/#74): the flame + count headline and, on a clean week, the
          Duolingo-style 7-day row — at the TOP, above the score/share row. Rides the
          shared fade/rise. Only for a streak-eligible solve (active day, real
          dayNumber); an archive replay and a ?puzzle= override show none. */}
      {showStreak && (
        <div className={`streak-block${streakIn ? ' in' : ''}`}>
          {/* Duolingo-style: the big flame + count are the headline, the small "DAY STREAK"
              label sits under them. SR reads "3 DAY STREAK"; the flame is decorative. */}
          <div className="streak-headline">
            <div className="streak-head">
              <span className="streak-flame" aria-hidden />
              {/* Ghost reserves the FINAL streak's width (so the counting digits never
                  shift the flame); the live overlay right-aligns the tallying number. */}
              <span className="streak-count">
                <span className="streak-count-ghost" aria-hidden="true">
                  {streak}
                </span>
                <span className="streak-count-live">{Math.round(shownStreak)}</span>
              </span>
            </div>
            <p className="streak-label">{t(lang, 'dayStreak')}</p>
          </div>
          {week.clean && <WeekRow cells={week.cells} lang={lang} />}
        </div>
      )}

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
          </span>
          <span className="solved-score-unit">{t(lang, guessCount === 1 ? 'try' : 'tries')}</span>
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
// headline above already announces the count, same rationale as the heat grid. Flat pixel
// squares (the heat-grid language): a solved day is filled, an unsolved/future day keeps
// the neutral surface, and TODAY is marked by its brightened label.
function WeekRow({ cells, lang }: { cells: WeekCell[]; lang: string }) {
  const labels = useMemo(() => mondayNarrowLabels(lang), [lang]);
  return (
    <div className="week-row" aria-hidden="true">
      {cells.map((c, i) => (
        <div
          key={c.dayNumber}
          className={'week-cell' + (c.solved ? ' solved' : '') + (c.isToday ? ' today' : '')}
        >
          <span className="week-label">{labels[i]}</span>
          <span className="week-mark" />
        </div>
      ))}
    </div>
  );
}
