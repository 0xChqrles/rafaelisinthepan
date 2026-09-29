import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { t } from '../../../i18n';
import { useArticleLang } from '../lang';
import useSeen from './useSeen';

// ATTENTION AS ARCS: the sentence's tokens in a row, and from the focus token an arc to every
// token it listens to — thicker the larger its share, the share printed under the token. What
// comes after the focus is dimmed; what it cannot hear yet (the causal mask) is struck out.
const VIEW_W = 600;
const VIEW_H = 110;

export default function Arcs({
  lang,
  tokens,
  focus,
  weights,
  hidden = [],
}: {
  lang: string;
  tokens: string[];
  focus: number;
  weights: (number | null)[];
  hidden?: number[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const said = useArticleLang();
  const slot = VIEW_W / tokens.length;
  const cx = (i: number) => slot * (i + 0.5);
  const pct = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 });
  return (
    <div ref={ref} className={`ar-arcs${seen ? ' seen' : ''}`}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className="ar-arcs-svg" aria-hidden="true">
        {weights.map((w, i) => {
          if (w === null || i === focus) return null;
          const lift = VIEW_H - 14 - Math.min(VIEW_H - 22, Math.abs(i - focus) * 32 + 22);
          const d = `M${cx(focus)} ${VIEW_H} C${cx(focus)} ${lift} ${cx(i)} ${lift} ${cx(i)} ${VIEW_H}`;
          return (
            <path
              key={i}
              d={d}
              pathLength={1}
              className="ar-arc"
              style={{ '--w': w, '--i': i } as CSSProperties}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <ol className="ar-tokens" style={{ gridTemplateColumns: `repeat(${tokens.length}, 1fr)` }}>
        {tokens.map((token, i) => {
          const w = weights[i];
          const state = i === focus ? 'focus' : hidden.includes(i) ? 'hidden' : i > focus ? 'after' : '';
          return (
            <li key={`${token}-${i}`} className={`ar-token ${state}`}>
              {state === 'hidden' ? (
                <s className="ar-token-word">{token}</s>
              ) : (
                <span className="ar-token-word">{token}</span>
              )}
              {state === 'focus' && <span className="sr-only">{` (${t(said, 'levelMarkFocus')})`}</span>}
              {state === 'hidden' && <span className="sr-only">{` (${t(said, 'levelMarkUnheard')})`}</span>}
              <span className="ar-token-share">{w !== null && i !== focus ? pct.format(w) : ' '}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
