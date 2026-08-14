import type { CSSProperties } from 'react';
import { chartField, histogramCopy, type HistogramCopy } from '../game/scores';
import type { ScorePlacement } from '../hooks/useScoreHistogram';
import { t } from '../i18n';
import type { Mode } from '../langs';

// The day's population on the solved screen (#170), drawn in the app's own grammar: a
// field of quantized BRICK columns — the anonymous crowd in the census's dim blue (the
// route drawing's "unfound" dress) — with the player's own band in the "you" GOLD, the
// field's two ends NAMED under it, and ONE terse line saying what N has earned. Those two
// numbers are the whole legend (user-decided 2026-08-15): the shape and the gold position
// carry the story, the ends say what the axis is worth, and the copy makes the one claim
// worth words with its number in the same gold as the bar it describes.
//
// The counts are the RANGES THE API RETURNED (the backend owns the edges) with their
// unreachable tail merged into one `+N` column — see `chartField`. Every column is
// quantized to whole bricks — a bar of discrete cells, never a smooth anti-aliased
// rectangle, because nothing in this app draws fractional pixels.
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

// The PLAYER's column is a MARKER, not a tally (user-decided 2026-08-15): it says "your
// score sits here", so it always draws at least one real brick — including on a day whose
// recorded population does not contain you (a submission the server refused, a GET that
// landed before your own write). A grey 2px stub where the gold belongs is the one thing
// this chart must never show: the whole point of an empty field is that YOUR bar is on it.
function unitsOf(count: number, peak: number, you: boolean): number {
  if (count <= 0) return you ? 1 : 0;
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
  // The owning stack's beat: when the chart may begin arriving (with the score block on
  // the sentence stage, after the rarity breakdown in Word mode's).
  start?: boolean;
}) {
  const settled = !animate;
  const shown = placement !== null && (settled || start);

  if (!shown) return <div className="score-slot" />;

  const { histogram, bucket } = placement;
  const { counts, you, low, high } = chartField(histogram.buckets, bucket);
  const peak = Math.max(...counts, 1);
  const copy = histogramCopy(mode, histogram.buckets, histogram.total, bucket);
  const { before, strong, after } = copyParts(lang, copy);

  return (
    <div
      className={`score-slot${settled ? ' settled' : ''}`}
      style={{ '--cols': counts.length } as CSSProperties}
    >
      {/* Decorative: the copy line below is the accessible reading of the same fact. */}
      <div className="score-plot" aria-hidden="true">
        <div className="score-field">
          {counts.map((count, index) => {
            const mine = index === you;
            const units = unitsOf(count, peak, mine);
            return (
              <span
                key={index}
                className={`score-col${mine ? ' you' : ''} in`}
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
        {/* The field's two ends, named — the only numbers on the chart. The right one
            wears its `+` because that column is the merged tail (see chartField). */}
        <div className="score-legend">
          <span>{low}</span>
          <span>{high}</span>
        </div>
      </div>
      <p className={`score-copy in${strong === null ? ' gold' : ''}`}>
        {before}
        {strong !== null && <strong>{strong}</strong>}
        {after}
      </p>
    </div>
  );
}
