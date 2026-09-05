import type { CSSProperties } from 'react';
import { srWordBreakdown } from '../i18n';
import { RARITY_NAMES } from '../game/wordGame';
import { RARITY_COLORS } from './rarity';

// The claims per rarity grade AS A BAR (user-decided 2026-09-05, replacing the chip row:
// "too many centered informations"): the sentence result's run ruler in Word mode's own
// terms — one segment per grade CLAIMED, as wide as its share of the claims, in the
// grade's colour, commonest first, its count under it the way the ruler numbers its ticks.
// ONE component for every surface that draws the breakdown — the result screen (where it
// rises in segment by segment once the tally lands) and the invite landing (settled) — so
// the two can never disagree about the same run; the OG card draws the same bar in SVG
// (`shared/cardSvg.ts`). Decorative: `srWordBreakdown` is the accessible line.
export default function WordRarityBar({
  counts,
  lang,
  shown = true,
  animate = false,
}: {
  counts: readonly number[];
  lang: string;
  // The beat it arrives on (the owning stack's); with `animate` off it simply stands.
  shown?: boolean;
  animate?: boolean;
}) {
  const claimed = RARITY_NAMES.map((grade, step) => ({ grade, count: counts[step] ?? 0 })).filter(
    (g) => g.count > 0,
  );
  if (claimed.length === 0) return null;
  return (
    <div className="run-ruler-frame">
      <div
        className={`word-bar${shown ? ' in' : ''}${animate ? '' : ' settled'}`}
        role="img"
        aria-label={srWordBreakdown(lang, claimed)}
      >
        {claimed.map(({ grade, count }, step) => (
          <span
            key={grade}
            className="word-bar-seg"
            style={{ '--step': step, flexGrow: count, color: RARITY_COLORS[grade] } as CSSProperties}
          >
            <span className="word-bar-num">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
