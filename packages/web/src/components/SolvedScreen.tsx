import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { bucketMeans, shareUrl } from '../game/share';
import { heatColor } from '@whippin/shared';
import useAnimatedNumber from '../hooks/useAnimatedNumber';

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
// screen (#9). The reconstructed sentence + attribution live above, in <SolvedCaption>.
export default function SolvedScreen({
  guessCount,
  trajectory,
  dayNumber,
  lang,
}: {
  guessCount: number;
  trajectory: number[]; // reconstruction % after each counted guess (one per try)
  dayNumber: number | null;
  lang: string; // packed into the share token (drives the link's click-through target)
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
    // What we share/copy: a headline line then the (unfurling) link, blank line between.
    const text = `Whippin #${dayNumber} ${guessCount}\n\n${url}`;

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
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return; // user dismissed the sheet
        // any other failure -> fall through to the clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied): nothing more we can do here.
    }
  }, [lang, dayNumber, guessCount, squares]);

  return (
    <div className="solved-results">
      {/* One flat square per bucket (3..18). AFTER the score is shown, neutral surface tiles
          roll in one by one (.shown + staggered --show-delay), then each colorizes to its
          bucket's MEAN reconstruction % one by one (.colorized + staggered --color-delay).
          heatColor: 0 = cold/far crimson .. 1 = hot/solved cyan — the same ramp as the
          rank exponents and the share card. Decorative — the score/share carry the real
          numbers. The grid keeps its height throughout, so nothing shifts. */}
      <div
        className={`heat-grid${gridShown ? ' shown' : ''}${gridColorized ? ' colorized' : ''}`}
        aria-hidden="true"
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
        <span className="solved-score">
          SCORE{' '}
          {/* Reserve the FINAL count's exact width with a hidden ghost (same font, letter-
              spacing and all), then overlay the live tally right-aligned on top — so the
              number counting 0 -> guessCount never changes width (9 -> 10 stays put). */}
          <span className="solved-score-num">
            <span className="solved-score-ghost" aria-hidden="true">
              {guessCount}
            </span>
            <span className="solved-score-live">{Math.round(shownScore)}</span>
          </span>
        </span>
        {dayNumber != null && (
          <button type="button" className={`share-key${copied ? ' copied' : ''}`} onClick={onShare}>
            {copied ? 'COPIED' : 'SHARE'}
          </button>
        )}
      </div>
    </div>
  );
}
