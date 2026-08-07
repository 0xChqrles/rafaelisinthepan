import { useCallback, useEffect, useState } from 'react';
import { dateForDayNumber, encodeWordResult } from '@whippin/shared';
import { t } from '../i18n';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import useShare from '../hooks/useShare';
import { RESULTS_IN_MS, SCORE_COUNT_MS } from './resultAnimation';

// Word mode's end-of-run screen (#156): the claim count with its unit NAMED (higher is
// better here — "12 WORDS" says what was counted) plus SHARE, in the tray the keyboard
// vacates — the same visual grammar as the sentence game's solved results, minus what a
// word run does not have (no trajectory, no opponents). The share link carries the
// word-mode token, so it unfurls into the word card and clicks through to the day's
// word route.
export default function WordEndScreen({
  score,
  dayNumber,
  lang,
  animate = true,
}: {
  score: number;
  dayNumber: number;
  lang: string;
  // A live run rises and tallies like the sentence result. Rehydrated runs render their
  // final state immediately, so revisiting a finished day never replays the celebration.
  animate?: boolean;
}) {
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // First rise into the tray the keyboard vacated, then count the claimed words up from zero.
  const [resultsIn, setResultsIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setResultsIn(true);
      return undefined;
    }
    const raf = requestAnimationFrame(() => setResultsIn(true));
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  const [countTarget, setCountTarget] = useState(() => (animate ? 0 : score));
  useEffect(() => {
    if (!animate) {
      setCountTarget(score);
      return undefined;
    }
    if (!resultsIn) return undefined;
    const id = window.setTimeout(() => setCountTarget(score), reduceMotion ? 0 : RESULTS_IN_MS);
    return () => window.clearTimeout(id);
  }, [animate, reduceMotion, resultsIn, score]);
  const shownScore = useAnimatedNumber(countTarget, !animate || reduceMotion ? 1 : SCORE_COUNT_MS);

  // The tally is this screen's LAST beat — no ruler colorize follows it, as it does in the
  // sentence tray — so the number itself marks the landing with a one-shot scale pop.
  // Not at zero: there is no count to land, and a popping 0 celebrates nothing.
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (!animate || reduceMotion || score === 0) return undefined;
    if (countTarget !== score) return undefined;
    const id = window.setTimeout(() => setLanded(true), SCORE_COUNT_MS);
    return () => window.clearTimeout(id);
  }, [animate, reduceMotion, countTarget, score]);

  // Delivery (native sheet / clipboard + the "COPIED" confirmation) is the shared hook's;
  // this screen only composes the word result's text.
  const { share, copied } = useShare();

  const onShare = useCallback(async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = `${origin}/s/${encodeWordResult({ lang, dayNumber, score })}`;
    const unit = t(lang, score === 1 ? 'word' : 'words').toLowerCase();
    // The day is named by its calendar date, like every share surface (decided
    // 2026-08-03) — the same string the card draws and the link resolves to.
    const headline = `Whippin AI ${dateForDayNumber(dayNumber)} — ${score} ${unit}`;
    await share(`${headline}\n\n${url}`);
  }, [lang, dayNumber, score, share]);

  return (
    <div className={`solved-results${resultsIn ? ' in' : ''}`}>
      <span className="solved-score">
        <span className={`solved-score-num${landed ? ' landed' : ''}`}>
          {/* Reserve the final width while the live number counts, matching Sentence mode. */}
          <span className="solved-score-ghost" aria-hidden="true">
            {score}
          </span>
          <span className="solved-score-live">{Math.round(shownScore)}</span>
        </span>
        <span className="solved-score-unit">
          {t(lang, score === 1 ? 'foundWord' : 'foundWords')}
        </span>
      </span>

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
