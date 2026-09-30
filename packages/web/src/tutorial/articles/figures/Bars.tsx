import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { useArticleLang } from '../lang';
import useSeen from './useSeen';

// PROBABILITIES AS BARS: one row per word, the bar's length its share of the largest.
export default function Bars({ rows }: { rows: [string, number][] }) {
  const lang = useArticleLang();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const max = Math.max(...rows.map(([, v]) => v));
  const fmt = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <div ref={ref} className={`ar-bars${seen ? ' seen' : ''}`}>
      {rows.map(([word, value], i) => (
        <div key={word} className="ar-bar-row" style={{ '--i': i } as CSSProperties}>
          <span className="ar-bar-word">{word}</span>
          <span className="ar-bar-track">
            <span className="ar-bar" style={{ '--w': value / max } as CSSProperties} />
          </span>
          <span className="ar-bar-value">{`${fmt.format(value)} %`}</span>
        </div>
      ))}
    </div>
  );
}
