import type { CSSProperties } from 'react';
import {
  scoreStanding,
  formatTopPct,
  standingUnits,
  TIGHT_STANDING_UNITS,
} from '../game/scores';
import type { ScorePlacementState } from '../hooks/useScoreHistogram';
import { t, tn } from '../i18n';
import type { Mode } from '../langs';

// Where the player stands in the day's population (#170) — one line, said outright
// (user-decided 2026-08-15, replacing the brick histogram: a field of bars asks to be
// decoded, where the rank is the answer already given).
//
//     RANK #16 OF 100   [ TOP 25% ]
//
// The two numbers deliberately measure different things (see `scoreStanding`): the rank is
// competition ranking, so a whole band shares it, while TOP is the midpoint of that band.
// Fifteen players ahead and twenty sharing the bucket is 16th out of 100 AND top quarter.
//
// The RANK NUMBER is the line's headline — bigger than the words around it and in the
// accent gold — and the TOP badge is an outlined stamp beside it, the page's own
// foreground drawn as a 1px rule around foreground type. The badge is gated TWICE
// (`scoreStanding`): above `PERCENT_MIN_TOTAL` recorded scores (user-decided 2026-08-15),
// because a percentage of a handful of players is false precision — and from
// `PERCENT_MIN_RANK` on (user-decided 2026-08-17), because a single-digit rank has already
// said the same thing outright and better.
//
// The component ALWAYS renders its fixed-height slot (the `.word-rarities` rule: hold the
// layout space while invisible), so the line arriving — or never arriving, on a silent
// failure — moves NOTHING under it. A rehydrated result renders settled and replays
// nothing.
export default function ScoreRank({
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
  // The owning stack's beat: when the line may arrive.
  start?: boolean;
}) {
  const settled = !animate;
  if (!(settled || start)) return <div className="score-slot" />;

  // The round trip is still in flight: RANKING... holds the slot, its letters carrying
  // a looping light wave (see `.score-ranking`). It resolves into the line, or into the
  // empty slot on the silent failure — never into an error.
  if (placement === 'pending') {
    const label = t(lang, 'scoreRanking');
    return (
      <p className="score-slot score-ranking">
        <span className="sr-only">{label}</span>
        <span className="score-ranking-wave" aria-hidden="true">
          {Array.from(label).map((ch, i) => (
            <span key={i} style={{ '--i': i } as CSSProperties}>
              {ch}
            </span>
          ))}
        </span>
      </p>
    );
  }

  const standing = placement
    ? scoreStanding(mode, placement.histogram.buckets, placement.histogram.total, placement.bucket)
    : null;
  if (standing === null) return <div className="score-slot" />;

  const rankLabel = t(lang, 'scoreRank');
  const ofLabel = tn(lang, 'scoreOf', standing.total);
  // Empty on a population too small for a percentage, or on a rank that already says it —
  // which also shortens the line, so the length estimate below reads the badge that is
  // actually drawn.
  const topLabel =
    standing.topPct === null ? '' : `${t(lang, 'scoreTop')} ${formatTopPct(standing.topPct)}%`;
  // A long standing steps the whole line down one size rather than running off a phone's
  // column (see `standingUnits`). The step is CSS's; this only says the line is long.
  const tight =
    standingUnits(rankLabel, ofLabel, standing.rank, topLabel) >= TIGHT_STANDING_UNITS;

  return (
    <p
      className={`score-slot score-rank${tight ? ' tight' : ''}${settled ? ' settled' : ' in'}`}
    >
      <span className="score-rank-text">
        <span className="score-rank-label">{rankLabel}</span>
        <span className="score-rank-num">#{standing.rank}</span>
        <span className="score-rank-label">{ofLabel}</span>
      </span>
      {topLabel && <span className="score-top">{topLabel}</span>}
    </p>
  );
}
