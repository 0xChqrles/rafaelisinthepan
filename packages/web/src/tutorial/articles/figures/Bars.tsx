import { useMemo, useRef } from 'react';
import MeterCanvas from '../../../components/MeterCanvas';
import { useArticleLang } from '../lang';
import useSeen from './useSeen';

// PROBABILITIES AS THE GAME'S METER: one row per word, its bar the hole's own CHARGE
// (`MeterCanvas`, the chip's Bayer fill on 2px cells, in the meter's cobalt) charged to its
// share of the largest, the front thinning into the dither the way a chip short of full ends.
// The rows charge one after another once the figure is on screen, each on the meter's own
// travel; under reduced motion they stand charged.
const STAGGER_MS = 90;
const CHARGE_MS = 520;

export default function Bars({ rows }: { rows: [string, number][] }) {
  const lang = useArticleLang();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const max = Math.max(...rows.map(([, v]) => v));
  const fmt = useMemo(() => new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [lang]);
  return (
    <div ref={ref} className="ar-bars">
      {rows.map(([word, value], i) => (
        <div key={word} className="ar-bar-row">
          <span className="ar-bar-word">{word}</span>
          <span className="ar-bar-meter" aria-hidden="true">
            <MeterCanvas value={seen ? (value / max) * 100 : 0} delayMs={i * STAGGER_MS} durationMs={CHARGE_MS} />
          </span>
          <span className="ar-bar-value">{`${fmt.format(value)} %`}</span>
        </div>
      ))}
    </div>
  );
}
