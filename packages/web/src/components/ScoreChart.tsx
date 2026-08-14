import type { CSSProperties } from 'react';
import { histogramCopy } from '../game/scores';
import type { ScorePlacement } from '../hooks/useScoreHistogram';
import { t, tn } from '../i18n';
import type { Mode } from '../langs';

// The day's population on the solved screen (#170): one bar per fixed score band, the
// player's band in the app's "you" GOLD, and ONE terse line saying what N has earned —
// the chart carries the story. It renders at ANY N: an empty field with your bar marked
// IS the come-back-later message, so nothing here gates on a minimum population.
//
// The bands are the RANGES THE API RETURNED, never restated edges (the backend owns them
// — see the root AGENTS.md), and the only numbers drawn are the field's two ends, so the
// axis reads without a legend: sentence tries ascend rightward (left is better), word
// claims ascend rightward (right is better) — which way is better is the copy's job.
export default function ScoreChart({
  placement,
  mode,
  lang,
}: {
  placement: ScorePlacement;
  mode: Mode;
  lang: string;
}) {
  const { histogram, bucket } = placement;
  const peak = Math.max(...histogram.buckets.map((b) => b.count), 1);
  const copy = histogramCopy(mode, histogram.buckets, histogram.total, bucket);
  const line =
    copy.kind === 'first'
      ? t(lang, 'scoreFirst')
      : copy.kind === 'others'
        ? copy.others === 1
          ? t(lang, 'scoreOther')
          : tn(lang, 'scoreOthers', copy.others)
        : tn(lang, 'scoreBeat', copy.pct);
  const first = histogram.buckets[0];
  const last = histogram.buckets[histogram.buckets.length - 1];

  return (
    <div className="score-chart">
      {/* Decorative: the copy line below is the accessible reading of the same fact. */}
      <div className="score-bars" aria-hidden="true">
        {histogram.buckets.map((b, index) => (
          <span
            key={index}
            className={`score-bar${index === bucket ? ' you' : ''}`}
            style={{ '--h': b.count / peak } as CSSProperties}
          />
        ))}
      </div>
      <div className="score-axis" aria-hidden="true">
        <span>{first.min}</span>
        <span>{last.max}</span>
      </div>
      <p className="score-copy">{line}</p>
    </div>
  );
}
