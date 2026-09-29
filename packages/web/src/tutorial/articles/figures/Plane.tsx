import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import type { PlanePoint } from '../types';
import Tabs from './Tabs';

// WORDS AS POINTS (the article's first figure, and its AVANT / APRÈS): a grid of plane units,
// each word a square, each edge its length printed across its middle. With several states the
// words glide from one to the other and the lengths are re-read.
const UNIT = 64;
const W = 6;
const H = 5.6;
const PAD = 20;
const SQUARE = 9;

const GLIDE_MS = 650;

const px = (x: number) => PAD + x * UNIT;
const py = (y: number) => PAD + (H - y) * UNIT;

export default function Plane({
  lang,
  states,
  edges,
  tabs,
}: {
  lang: string;
  states: PlanePoint[][];
  edges: [number, number][];
  tabs?: string[];
}) {
  const [at, setAt] = useState(0);
  const [points, setPoints] = useState(states[0]);
  const shown = useRef(points);
  shown.current = points;
  // A tab glides every word from where it stands to its place in the picked state — the
  // edges and their lengths follow, re-read on every frame.
  useEffect(() => {
    const target = states[Math.min(at, states.length - 1)];
    const from = shown.current;
    if (prefersReducedMotion()) {
      setPoints(target);
      return undefined;
    }
    const start = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / GLIDE_MS);
      const e = 1 - (1 - k) ** 3;
      setPoints(
        target.map((p, i) => ({ ...p, x: from[i].x + (p.x - from[i].x) * e, y: from[i].y + (p.y - from[i].y) * e })),
      );
      if (k < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [at, states]);
  const fmt = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const ys = states.flat().map((p) => p.y);
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - 0.5));
  const y1 = Math.ceil(Math.max(...ys) + 0.6);
  const px = (x: number) => PAD + x * UNIT;
  const py = (y: number) => PAD + (y1 - y) * UNIT;
  const width = PAD * 2 + W * UNIT;
  const height = PAD * 2 + (y1 - y0) * UNIT;
  return (
    <div className="ar-plane">
      {tabs && <Tabs labels={tabs} active={at} onPick={setAt} />}
      <svg viewBox={`0 0 ${width} ${height}`} className="ar-plane-svg" aria-hidden="true">
        {Array.from({ length: W + 1 }, (_, i) => (
          <line key={`x${i}`} className="ar-grid" x1={px(i)} x2={px(i)} y1={py(y0)} y2={py(y1)} />
        ))}
        {Array.from({ length: y1 - y0 + 1 }, (_, i) => (
          <line key={`y${i}`} className="ar-grid" x1={px(0)} x2={px(W)} y1={py(y0 + i)} y2={py(y0 + i)} />
        ))}
        {edges.map(([a, b]) => {
          const p = points[a];
          const q = points[b];
          const d = Math.hypot(p.x - q.x, p.y - q.y);
          // A short edge has no room for its length between its two squares: the number
          // steps off the edge, up its normal.
          const lift = d * UNIT < 96 ? 24 : 0;
          const nx = d ? (-(q.y - p.y) / d) * Math.sign(q.x - p.x || 1) : 0;
          const ny = d ? (-(q.x - p.x) / d) * Math.sign(q.x - p.x || 1) : 0;
          const mx = (px(p.x) + px(q.x)) / 2 + nx * lift;
          const my = (py(p.y) + py(q.y)) / 2 + ny * lift;
          return (
            <g key={`${a}-${b}`}>
              <line className="ar-edge" x1={px(p.x)} y1={py(p.y)} x2={px(q.x)} y2={py(q.y)} />
              <g className="ar-edge-label" style={{ transform: `translate(${mx}px, ${my}px)` }}>
                <rect x={-19} y={-11} width={38} height={22} />
                <text textAnchor="middle" dominantBaseline="central">
                  {fmt.format(d)}
                </text>
              </g>
            </g>
          );
        })}
        {points.map((p) => (
          <g
            key={p.word}
            className={`ar-point${p.focus ? ' focus' : ''}`}
            style={{ transform: `translate(${px(p.x)}px, ${py(p.y)}px)` }}
          >
            <rect x={-SQUARE / 2} y={-SQUARE / 2} width={SQUARE} height={SQUARE} />
            <text
              textAnchor="middle"
              y={p.label === 'below' ? SQUARE + 16 : -SQUARE - 6}
            >
              {p.word}
            </text>
          </g>
        ))}
      </svg>
      <p className="sr-only">
        {edges
          .map(([a, b]) => {
            const p = points[a];
            const q = points[b];
            return `${p.word} – ${q.word} : ${fmt.format(Math.hypot(p.x - q.x, p.y - q.y))}`;
          })
          .join(' ; ')}
      </p>
    </div>
  );
}
