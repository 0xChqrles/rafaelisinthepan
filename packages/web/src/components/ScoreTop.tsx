import { scoreStanding, formatTopPct } from '../game/scores';
import type { ScorePlacementState } from '../hooks/useScoreHistogram';
import { t } from '../i18n';
import type { Mode } from '../langs';

// Where the player stands in the day's population (#170) — ONE badge, `TOP 25%`, beside
// the score (user-decided 2026-09-05, superseding the `RANK #16 OF 100` line: "the rank #
// line should be dropped, we could keep the TOP% only").
//
// The badge is gated THREE times (`scoreStanding`, unchanged): above `PERCENT_MIN_TOTAL`
// recorded scores, because a percentage of a handful of players is false precision; from
// `PERCENT_MIN_RANK` on, because a single-digit standing is too small a field to blur into
// a percentage; and no farther down than `PERCENT_MAX`, the median, because TOP is a claim
// and `TOP 99%` is that claim turned against the player wearing it. The rank is still
// COMPUTED — it is what the second gate reads — it is simply no longer drawn.
//
// It is ABSOLUTELY placed beside the number (`.score-top`), so arriving — or never
// arriving, on a silent failure or while the population is still answering — moves
// nothing: the score stays centred and the ruler under it stays put. A rehydrated result
// renders settled and replays nothing.
export default function ScoreTop({
  placement,
  mode,
  lang,
  animate = true,
  start = true,
}: {
  placement: ScorePlacementState;
  mode: Mode;
  lang: string;
  // Rehydrated results render settled and replay nothing (the whole stack's contract).
  animate?: boolean;
  // The owning stack's beat: when the badge may arrive.
  start?: boolean;
}) {
  const settled = !animate;
  if (!(settled || start)) return null;
  if (placement === 'pending' || placement === null) return null;
  const standing = scoreStanding(
    mode,
    placement.histogram.buckets,
    placement.histogram.total,
    placement.bucket,
  );
  if (standing === null || standing.topPct === null) return null;
  return (
    <span className={`score-top${settled ? ' settled' : ' in'}`}>
      {t(lang, 'scoreTop')} {formatTopPct(standing.topPct)}%
    </span>
  );
}
