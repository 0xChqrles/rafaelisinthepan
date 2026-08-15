import {
  scoreStanding,
  formatTopPct,
  standingUnits,
  TIGHT_STANDING_UNITS,
} from '../game/scores';
import type { ScorePlacement } from '../hooks/useScoreHistogram';
import { t, tn } from '../i18n';
import type { Mode } from '../langs';

// Where the player stands in the day's population (#170) — one line, said outright
// (user-decided 2026-08-15, replacing the brick histogram: a field of bars asks to be
// decoded, where the rank is the answer already given).
//
//     RANK #5 OF 59   [ TOP 8.47% ]
//
// The RANK NUMBER is the line's headline — bigger than the words around it and in the
// solved blue, the colour of what the round found — and the TOP badge is a filled stamp
// beside it, gold on the app's own background, the way an achievement reads here. The
// badge rides ALONG with the rank at every population size (user-decided 2026-08-15): the
// line is one thing, and a player standing on a quiet day gets the same line as one
// standing on a busy one. Its ground is the page's own foreground, not the gold — gold is
// the colour of what the player HOLDS, and a standing is not held.
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
  placement: ScorePlacement | null;
  mode: Mode;
  lang: string;
  // Rehydrated results render settled and replay nothing (the whole stack's contract).
  animate?: boolean;
  // The owning stack's beat: when the line may arrive.
  start?: boolean;
}) {
  const settled = !animate;
  const standing = placement
    ? scoreStanding(mode, placement.histogram.buckets, placement.histogram.total, placement.bucket)
    : null;
  if (standing === null || !(settled || start)) return <div className="score-slot" />;

  const rankLabel = t(lang, 'scoreRank');
  const ofLabel = tn(lang, 'scoreOf', standing.total);
  const topLabel = `${t(lang, 'scoreTop')} ${formatTopPct(standing.topPct)}%`;
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
      <span className="score-top">{topLabel}</span>
    </p>
  );
}
