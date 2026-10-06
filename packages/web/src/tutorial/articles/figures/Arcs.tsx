import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import { t } from '../../../i18n';
import { useArticleLang } from '../lang';
import { CELL, CellCanvas, lineCells, useWidth, type Cells } from './cells';
import { runSteps } from './steps';
import useSeen from './useSeen';

// ATTENTION AS ARCS: the sentence's tokens in a row, set in the pixel face as the game sets a
// sentence — the focus token on the held chip's white ground, what comes after it in the
// secondary ink, what it cannot hear yet (the causal mask) struck out — and from the focus an
// arc to every token it listens to, drawn on the house's 2px cells: thicker the larger its
// share (one cell to three) — a share too small for a second cell a DASHED thread, so a weak
// one reads weak at a glance — the share printed under the token in the pixel figures. The arcs
// draw themselves out of the focus, cell by cell in hard steps, once the figure is on screen;
// under reduced motion they stand drawn.
const ROWS_WIDE = 44;
const ROWS_NARROW = 32;
// Where the token row is narrow enough for the 8px face.
const NARROW_PX = 520;
const DRAW_STEPS = 8;
const DRAW_MS = 480;

// The cells of one arc, in drawing order from the focus: a half-ellipse standing on the
// drawing's foot, joined cell to cell so it never breaks.
function arcCells(x0: number, x1: number, base: number, h: number): [number, number][] {
  const xm = (x0 + x1) / 2;
  const n = Math.ceil(Math.PI * Math.max(Math.abs(x1 - x0) / 2, h)) * 2;
  const out: [number, number][] = [];
  let last: [number, number] | null = null;
  for (let k = 0; k <= n; k += 1) {
    const th = (Math.PI * k) / n;
    const p: [number, number] = [Math.round(xm + (x0 - xm) * Math.cos(th)), Math.round(base - h * Math.sin(th))];
    if (last && (last[0] !== p[0] || last[1] !== p[1])) out.push(...lineCells(last[0], last[1], p[0], p[1]).slice(1));
    else if (!last) out.push(p);
    last = p;
  }
  return out;
}

export default function Arcs({
  tokens,
  focus,
  weights,
  hidden = [],
}: {
  tokens: string[];
  focus: number;
  weights: (number | null)[];
  hidden?: number[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const width = useWidth(ref);
  const lang = useArticleLang();
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    if (!seen) return undefined;
    if (prefersReducedMotion()) {
      setDrawn(1);
      return undefined;
    }
    return runSteps(DRAW_STEPS, DRAW_MS, (k) => setDrawn(k / DRAW_STEPS));
  }, [seen]);

  const cols = Math.floor(width / CELL);
  const rows = width < NARROW_PX ? ROWS_NARROW : ROWS_WIDE;
  const arcs = useMemo(() => {
    if (cols <= 0) return [];
    const centre = (i: number) => Math.round(((i + 0.5) * cols) / tokens.length);
    return weights.flatMap((w, i) => {
      if (w === null || i === focus) return [];
      const x0 = centre(focus);
      const x1 = centre(i);
      const h = Math.min(rows - 3, Math.round(Math.abs(x1 - x0) * 0.45));
      return [{ cells: arcCells(x0, x1, rows - 1, h), thick: 1 + Math.round(w * 2) }];
    });
  }, [cols, rows, tokens.length, weights, focus]);

  const draw = useCallback(
    (cells: Cells) => {
      for (const arc of arcs) {
        const shown = Math.ceil(arc.cells.length * drawn);
        const off = Math.floor(arc.thick / 2);
        for (let k = 0; k < shown; k += 1) {
          // A one-cell thread is dashed: two cells drawn, two left out.
          if (arc.thick === 1 && k % 4 >= 2) continue;
          const [x, y] = arc.cells[k];
          cells.block(x - off, Math.min(y - off, rows - arc.thick), arc.thick, arc.thick, 'fg');
        }
      }
    },
    [arcs, drawn, rows],
  );

  return (
    <div ref={ref} className="ar-arcs">
      {cols > 0 && <CellCanvas cols={cols} rows={rows} draw={draw} />}
      <ol className="ar-tokens" style={{ gridTemplateColumns: `repeat(${tokens.length}, minmax(0, 1fr))` }}>
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
              {state === 'focus' && <span className="sr-only">{` (${t(lang, 'levelMarkFocus')})`}</span>}
              {state === 'hidden' && <span className="sr-only">{` (${t(lang, 'levelMarkUnheard')})`}</span>}
              <span className="ar-token-share">{w !== null && i !== focus ? `${Math.round(w * 100)} %` : ' '}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
