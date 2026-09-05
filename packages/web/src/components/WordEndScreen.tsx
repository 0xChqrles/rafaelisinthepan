import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { prefersReducedMotion } from '../hooks/useScramble';
import { t, srWordBreakdown } from '../i18n';
import { RARITY_NAMES } from '../game/wordGame';
import useAnimatedNumber from '../hooks/useAnimatedNumber';
import type { ScorePlacementState } from '../hooks/useScoreHistogram';
import useShare from '../hooks/useShare';
import Button from './Button';
import ShareAs, { useShareSigner } from './ShareAs';
import { RARITY_COLORS } from './rarity';
import ScoreTop from './ScoreTop';
import { shareHeadline, wordShareText, wordShareUrl, wordShareScore } from '../game/share';
import { RESULTS_IN_MS, SCORE_COUNT_MS } from './resultAnimation';

// Word mode's end-of-run screen (#156): the claim count with its unit NAMED (higher is
// better here — "12 WORDS" says what was counted), its per-rarity CHIP ROW, plus SHARE,
// in the tray the keyboard vacates. Since 2026-08-15 it is not merely the same GRAMMAR as
// the sentence result but the same STACK, at the same sizes (user-decided): the day's
// standing, then the number, then SHARE, minus what a word run does not have (no
// trajectory, no opponents). The
// share link carries the word-mode token — the per-rarity claim counts plus the accented
// public word — so it unfurls into the word card with its rarity chip row, and clicks
// through to the day's word route. The screen takes the BREAKDOWN and derives the count
// from it, so the tally, the chips, the text, the token and the card all speak from one
// set of numbers.
export default function WordEndScreen({
  counts,
  dayNumber,
  lang,
  word,
  placement = null,
  animate = true,
}: {
  counts: readonly number[]; // claims per rarity grade, commonest first (ladder order)
  dayNumber: number;
  lang: string;
  word: string; // accented display form carried into the OG card
  // The day's score population (#170): 'pending' while the submit/fetch round trip is
  // in flight (the slot shows RANKING...), the placement once it landed. Null renders
  // no chart and no message — the silent-degrade decision.
  placement?: ScorePlacementState;
  // A live run rises and tallies like the sentence result. Rehydrated runs render their
  // final state immediately, so revisiting a finished day never replays the celebration.
  animate?: boolean;
}) {
  const score = useMemo(() => wordShareScore(counts), [counts]);
  const reduceMotion = prefersReducedMotion();

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

  // The tally's landing marks itself with a one-shot scale pop — no ruler colorize
  // follows it, as it does in the sentence tray; the BREAKDOWN below is what unpacks the
  // number instead. Not at zero: there is no count to land, and a popping 0 celebrates
  // nothing.
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (!animate || reduceMotion || score === 0) return undefined;
    if (countTarget !== score) return undefined;
    const id = window.setTimeout(() => setLanded(true), SCORE_COUNT_MS);
    return () => window.clearTimeout(id);
  }, [animate, reduceMotion, countTarget, score]);

  // The grades the run claimed, ladder order, zeroes absent — the OG card's chip row and
  // the share text's bead row, on screen. One derivation for the whole row, so what the
  // chips say is exactly what the message will.
  const claimedGrades = useMemo(
    () =>
      RARITY_NAMES.map((grade, step) => ({ grade, count: counts[step] ?? 0 })).filter(
        (g) => g.count > 0,
      ),
    [counts],
  );

  // The breakdown is the result's LAST beat: it unpacks the number the tally just landed,
  // so it waits for that landing (the pop's own moment) and then each chip rises in on its
  // own delay, commonest first. Under reduced motion the count lands immediately and the
  // global rule collapses the chips' rise to its delays — the floating numbers' own
  // degradation. A rehydrated result renders the row settled, replaying nothing.
  const [breakdownIn, setBreakdownIn] = useState(() => !animate);
  useEffect(() => {
    if (!animate) {
      setBreakdownIn(true);
      return undefined;
    }
    if (countTarget !== score) return undefined;
    const id = window.setTimeout(() => setBreakdownIn(true), reduceMotion ? 0 : SCORE_COUNT_MS);
    return () => window.clearTimeout(id);
  }, [animate, reduceMotion, countTarget, score]);

  // The STANDING heads this stack, as it heads the sentence result's (2026-08-15, when the
  // two were made one layout), so it arrives WITH the block: a line sitting ABOVE the tally
  // must not land after it. It holds its layout slot from the start, so this changes when
  // it appears, never where anything sits.
  const chartStart = resultsIn;

  // Delivery (native sheet / clipboard + the "COPIED" confirmation) is the shared hook's;
  // this screen only composes the word result's text.
  const { share, copied } = useShare();
  // The AS drum under SHARE (see ShareAs): fresh on every mount, never remembered.
  const signer = useShareSigner();

  // This screen owns only the LOCALIZED headline; the body's composition — the word, its
  // bead row, the blank lines — is `game/share.ts`'s, next to the sentence twin it mirrors.
  const onShare = useCallback(async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = wordShareUrl(origin, { lang, dayNumber, counts, word }, signer.by);
    const unit = t(lang, score === 1 ? 'word' : 'words').toLowerCase();
    const headline = shareHeadline(dayNumber, score, unit);
    await share(wordShareText(headline, word, lang, counts, url));
  }, [lang, dayNumber, counts, score, share, word, signer.by]);

  return (
    <div className={`solved-results${resultsIn ? ' in' : ''}`}>
      {/* The run's own number, then SHARE: the sentence result's exact stack (user-decided
          2026-08-15, "the exact same layout and sizing"). Where this run stands among the
          day's players (#170) is the TOP badge BESIDE the number (user-decided 2026-09-05),
          absolutely placed so its arrival moves nothing. */}
      <span className="solved-score">
        <span className="solved-score-line">
          <span className={`solved-score-num${landed ? ' landed' : ''}`}>
            {/* Reserve the final width while the live number counts, matching Sentence mode. */}
            <span className="solved-score-ghost" aria-hidden="true">
              {score}
            </span>
            <span className="solved-score-live">{Math.round(shownScore)}</span>
          </span>
          <ScoreTop placement={placement} mode="word" lang={lang} animate={animate} start={chartStart} />
        </span>
        <span className="solved-score-unit">
          {t(lang, score === 1 ? 'foundWord' : 'foundWords')}
        </span>
        {claimedGrades.length > 0 && (
          <span
            className={`word-rarities${animate ? '' : ' settled'}`}
            role="img"
            aria-label={srWordBreakdown(lang, claimedGrades)}
          >
            {claimedGrades.map(({ grade, count }, step) => (
              <span
                key={grade}
                className={`word-rarity${breakdownIn ? ' in' : ''}`}
                style={{ '--step': step, color: RARITY_COLORS[grade] } as CSSProperties}
              >
                <i className="word-rarity-square" />
                {count}
              </span>
            ))}
          </span>
        )}
      </span>

      <div className="result-actions">
        <Button
          variant="secondary"
          className={`result-action${copied ? ' copied' : ''}`}
          onClick={onShare}
        >
          {copied ? t(lang, 'copied') : t(lang, 'share')}
        </Button>
        <ShareAs lang={lang} signer={signer} />
      </div>
    </div>
  );
}
