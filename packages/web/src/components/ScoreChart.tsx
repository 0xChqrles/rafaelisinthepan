import type { CSSProperties } from 'react';
import { histogramCopy, type HistogramCopy } from '../game/scores';
import type { ScorePlacement } from '../hooks/useScoreHistogram';
import { t } from '../i18n';
import type { Mode } from '../langs';

// The day's population on the solved screen (#170), drawn in the app's own grammar: a
// field of quantized BRICK columns — the anonymous crowd in the census's dim blue (the
// route drawing's "unfound" dress) — with the player's own band in the "you" GOLD, and
// ONE terse line under it saying what N has earned. No axis, no legend: the shape and the
// gold position carry the story (show, don't tell), the copy makes the one claim worth
// words, with its number in the same gold as the bar it describes.
//
// The bands are the RANGES THE API RETURNED (the backend owns the edges), and every
// column is quantized to whole bricks — a bar of discrete cells, never a smooth
// anti-aliased rectangle, because nothing in this app draws fractional pixels.
//
// The component ALWAYS renders its fixed-height slot (the `.word-rarities` rule: hold the
// layout space while invisible, so the chart's arrival moves NOTHING under it — SHARE
// must not jump while the player reads). The content appears inside when the population
// actually came back AND the result stack's own beat says so: columns rise in left to
// right (`rung-in`, the app's one "list arriving" gesture), the gold column lands after
// the field, and the copy speaks last. A rehydrated result renders settled and replays
// nothing; a failed round trip leaves the slot empty and silent by decision.

// A column is at most this many bricks tall; the fullest band always reaches it and any
// non-empty band shows at least one brick.
const MAX_UNITS = 6;

function unitsOf(count: number, peak: number): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.ceil((count / peak) * MAX_UNITS));
}

// The copy line split around its highlighted value, so the number can wear the gold
// without the localized sentence being assembled in code: the `{n}` placeholder marks
// where the value sits in BOTH languages, exactly as the gate's `tn` line does.
function copyParts(
  lang: string,
  copy: HistogramCopy,
): { before: string; strong: string | null; after: string } {
  if (copy.kind === 'first') return { before: t(lang, 'scoreFirst'), strong: null, after: '' };
  const key = copy.kind === 'percent' ? 'scoreBeat' : copy.others === 1 ? 'scoreOther' : 'scoreOthers';
  const value = copy.kind === 'percent' ? `${copy.pct}%` : String(copy.others);
  const [before, after = ''] = t(lang, key).split('{n}');
  return { before, strong: value, after };
}

export default function ScoreChart({
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
  // The owning stack's beat: when the chart may begin arriving (after the ruler's
  // colorize in the sentence tray, after the rarity breakdown in Word mode's).
  start?: boolean;
}) {
  const settled = !animate;
  const shown = placement !== null && (settled || start);

  if (!shown) return <div className="score-slot" />;

  const { histogram, bucket } = placement;
  const peak = Math.max(...histogram.buckets.map((b) => b.count), 1);
  const copy = histogramCopy(mode, histogram.buckets, histogram.total, bucket);
  const { before, strong, after } = copyParts(lang, copy);

  return (
    <div
      className={`score-slot${settled ? ' settled' : ''}`}
      style={{ '--cols': histogram.buckets.length } as CSSProperties}
    >
      {/* Decorative: the copy line below is the accessible reading of the same fact. */}
      <div className="score-field" aria-hidden="true">
        {histogram.buckets.map((b, index) => {
          const units = unitsOf(b.count, peak);
          return (
            <span
              key={index}
              className={`score-col${index === bucket ? ' you' : ''} in`}
              style={{ '--step': index } as CSSProperties}
            >
              {units === 0 ? (
                <i className="score-stub" />
              ) : (
                Array.from({ length: units }, (_, u) => <i key={u} className="score-brick" />)
              )}
            </span>
          );
        })}
      </div>
      <p className={`score-copy in${strong === null ? ' gold' : ''}`}>
        {before}
        {strong !== null && <strong>{strong}</strong>}
        {after}
      </p>
    </div>
  );
}
