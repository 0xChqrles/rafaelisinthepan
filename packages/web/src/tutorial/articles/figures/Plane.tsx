import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { heatColor } from '@whippin/shared';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import { useArticleLang } from '../lang';
import type { PlanePoint } from '../types';
import { CELL, CellCanvas, lineCells, useWidth, type Cells } from './cells';
import { easedStep, runSteps } from './steps';
import Tabs from './Tabs';

// WORDS AS POINTS (the article's first figure, and its AVANT / APRÈS), drawn with the game's own
// pieces on the house's 2px cells: the plane's lattice as the floor's stipple (a slate dot where
// two lines would cross), each word a square on it with its NAME as the game shows a word — the
// pixel face on the held chip's white ground, the subject in the found cobalt ink with no chip —
// and each pair joined by a stippled line with its LENGTH printed across its middle in the HEAT
// RAMP, the game's one way of saying how far (a rank exponent's ink): calm cobalt for a near
// pair, the weird red for a far one, on one scale for every plane (`FAR`). With several states
// the words TRAVEL from one to the other in hard steps (the board's chip's travel) and the
// lengths are re-read at each; a word's name keeps its side (`label`) in every state, so it
// never jumps across its square.
const UNITS = 6;
// The cells round the lattice: room for a name past the outer squares.
const PAD = 4;
// The plane's widest drawing (CSS px): past it a unit only spends height.
const MAX_W = 460;
// A word's square, in cells, and the air between it and its name's chip.
const SQUARE = 4;
const NAME_GAP = 4;
// A name in the pixel face, one em a glyph: 16px where the plane is wide, 8px on a phone; the
// chip round it a cell above and below, two (16px) or one (8px) cells each side.
const WIDE_PX = 440;
const CHIP_Y = 2;
// A length: the names' figures with a cell of ground round them.
const LENGTH_PAD = 2;
// The distance (plane units) at which a length reaches the ramp's weird end.
const FAR = 4;
// The travel between two states.
const TRAVEL_STEPS = 6;
const TRAVEL_MS = 300;

const lengthInk = (d: number) => heatColor(1 - d / FAR);

export default function Plane({
  states,
  edges,
  tabs,
}: {
  states: PlanePoint[][];
  edges: [number, number][];
  tabs?: string[];
}) {
  const lang = useArticleLang();
  const boxRef = useRef<HTMLDivElement>(null);
  const width = Math.min(MAX_W, useWidth(boxRef));
  const [at, setAt] = useState(0);
  const [points, setPoints] = useState(states[0]);
  const shown = useRef(points);
  shown.current = points;

  // A state picked: every word travels from where it stands to its place there, in hard steps.
  const target = states[Math.min(at, states.length - 1)];
  useEffect(() => {
    const from = shown.current;
    if (from === target) return undefined;
    if (prefersReducedMotion()) {
      setPoints(target);
      return undefined;
    }
    return runSteps(TRAVEL_STEPS, TRAVEL_MS, (k) => {
      const e = easedStep(k, TRAVEL_STEPS);
      setPoints(
        k === TRAVEL_STEPS
          ? target
          : target.map((p, i) => ({ ...p, x: from[i].x + (p.x - from[i].x) * e, y: from[i].y + (p.y - from[i].y) * e })),
      );
    });
  }, [target]);

  const fmt = useMemo(() => new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [lang]);
  const ys = states.flat().map((p) => p.y);
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - 0.5));
  const y1 = Math.ceil(Math.max(...ys) + 0.6);

  // The lattice's unit in whole cells, off the box's width.
  const unit = Math.max(8, Math.floor((Math.floor(width / CELL) - 2 * PAD) / UNITS));
  const cols = 2 * PAD + UNITS * unit;
  const rows = 2 * PAD + (y1 - y0) * unit;
  const cx = useCallback((x: number) => PAD + Math.round(x * unit), [unit]);
  const cy = useCallback((y: number) => PAD + Math.round((y1 - y) * unit), [unit, y1]);
  const namePx = width >= WIDE_PX ? 16 : 8;
  const chipX = namePx / 4;

  const draw = useCallback(
    (cells: Cells) => {
      // The lattice: one slate cell where each two lines cross.
      for (let i = 0; i <= UNITS; i += 1) {
        for (let j = y0; j <= y1; j += 1) cells.set(cx(i), cy(j), 'rail');
      }
      // The pairs: a stippled line, a cell every other, from square to square.
      for (const [a, b] of edges) {
        const run = lineCells(cx(points[a].x), cy(points[a].y), cx(points[b].x), cy(points[b].y));
        run.forEach(([x, y], i) => i % 2 === 0 && cells.set(x, y, 'muted'));
      }
      // The words' squares, the subject's in the accent.
      for (const p of points) {
        const h = SQUARE / 2;
        cells.block(cx(p.x) - h, cy(p.y) - h, SQUARE, SQUARE, p.focus ? 'accent' : 'fg');
      }
    },
    [points, edges, cx, cy, y0, y1],
  );

  const drawW = cols * CELL;
  const drawH = rows * CELL;
  const px = (c: number) => c * CELL;
  const half = (SQUARE / 2) * CELL;

  return (
    <div className="ar-plane">
      {tabs && <Tabs labels={tabs} active={at} onPick={setAt} />}
      <div ref={boxRef} className="ar-plane-box">
        {width > 0 && (
          <div className="ar-plane-draw" style={{ width: drawW, height: drawH }} aria-hidden="true">
            <CellCanvas cols={cols} rows={rows} draw={draw} />
            {edges.map(([a, b]) => {
              const p = points[a];
              const q = points[b];
              const d = Math.hypot(p.x - q.x, p.y - q.y);
              const text = fmt.format(d);
              const w = text.length * namePx + 2 * LENGTH_PAD;
              const h = namePx + 2 * LENGTH_PAD;
              const ax = px(cx(p.x));
              const ay = px(cy(p.y));
              const bx = px(cx(q.x));
              const by = px(cy(q.y));
              // The length sits ON its line, unless its box would cover one of the two squares
              // (a pair too close for it): then it steps off along the normal, away from the
              // words' names — below the line when both name above, above otherwise.
              const crowded = Math.abs(bx - ax) / 2 < w / 2 + half && Math.abs(by - ay) / 2 < h / 2 + half;
              const away = p.label !== 'below' && q.label !== 'below' ? -1 : 1;
              const len = Math.hypot(bx - ax, by - ay) || 1;
              const sign = Math.sign(bx - ax || 1);
              const lift = crowded ? (h / 2 + half + 4) * away : 0;
              // The normal (dy, −dx), turned to point up the screen for a pair read left to right.
              const mx = (ax + bx) / 2 + ((by - ay) / len) * sign * lift;
              const my = (ay + by) / 2 + (-(bx - ax) / len) * sign * lift;
              return (
                <span
                  key={`${a}-${b}`}
                  className="ar-plane-length"
                  style={
                    {
                      left: Math.round(mx - w / 2),
                      top: Math.round(my - h / 2),
                      fontSize: namePx,
                      '--length-ink': lengthInk(d),
                    } as CSSProperties
                  }
                >
                  {text}
                </span>
              );
            })}
            {points.map((p) => {
              // The name's chip, centred over (or under) its square and kept inside the drawing.
              const w = p.word.length * namePx + 2 * chipX;
              const h = namePx + 2 * CHIP_Y;
              const left = Math.min(drawW - w, Math.max(0, px(cx(p.x)) - Math.round(w / 2)));
              const top = p.label === 'below' ? px(cy(p.y)) + half + NAME_GAP : px(cy(p.y)) - half - NAME_GAP - h;
              return (
                <span
                  key={p.word}
                  className={`ar-plane-word${p.focus ? ' focus' : ''}`}
                  style={{ left, top, fontSize: namePx, padding: `${CHIP_Y}px ${chipX}px` }}
                >
                  {p.word}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {/* What the drawing says, in words: the final lengths of the state shown, re-read when a
          state is picked. */}
      <p className="sr-only" aria-live={tabs ? 'polite' : undefined}>
        {edges
          .map(([a, b]) => {
            const p = target[a];
            const q = target[b];
            return `${p.word} – ${q.word} : ${fmt.format(Math.hypot(p.x - q.x, p.y - q.y))}`;
          })
          .join(' ; ')}
      </p>
    </div>
  );
}
