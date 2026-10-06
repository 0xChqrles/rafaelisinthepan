import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BoardRank } from '../../../components/BoardRows';
import { LINE_PX } from '../../../components/boardMetrics';
import { prefersReducedMotion } from '../../../hooks/useScramble';
import { t } from '../../../i18n';
import { useArticleLang } from '../lang';
import { CELL, CellCanvas, lineCells, useWidth, type Cells } from './cells';
import { runSteps } from './steps';
import useSeen from './useSeen';

// THE TOP OF A REAL TOURNAMENT, AS THE BOARD THE GAME DRAWS: on the right the tournament's
// places as the boards' own LINES (`BoardRows`' dress: the rank in the quiet pixel face, FIRST
// PLACE WEARING THE CROWN, the word in the names' type, its mean win probability in the pixel
// figures at the far edge, a skipped place the stippled rail of the rows a board leaves out),
// one line's pitch apart; on the left each word's place by its grade, in the same quiet
// figures; between them a line from one to the other on the house's 2px cells — solid white
// where the word climbs, the slate stipple where it holds or falls. The lines draw themselves
// from the grade to the tournament, cell by cell in hard steps, once the figure is on screen.
// Screen readers get the same figures as a table.
// The lines' gutter, in cells — narrower in the narrowest column (`NARROW_PX`, the figure's own
// width, its CSS keyed on `.narrow`), so every word and its probability keep their room.
const GUTTER_CELLS = 20;
const GUTTER_NARROW_CELLS = 12;
const NARROW_PX = 320;
// A line's pitch in cells, and the cell row through a slot's middle.
const PITCH = LINE_PX / CELL;
const mid = (slot: number) => Math.round((slot + 0.5) * PITCH);
const DRAW_STEPS = 8;
const DRAW_MS = 420;

export default function Tournament({
  rows,
  heads,
  labels,
}: {
  rows: { word: string; from: number; win: number; to?: number }[];
  heads: [string, string, string];
  labels: [string, string, string];
}) {
  const lang = useArticleLang();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const width = useWidth(ref);
  const narrow = width > 0 && width < NARROW_PX;
  const gutter = narrow ? GUTTER_NARROW_CELLS : GUTTER_CELLS;
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    if (!seen) return undefined;
    if (prefersReducedMotion()) {
      setDrawn(1);
      return undefined;
    }
    return runSteps(DRAW_STEPS, DRAW_MS, (k) => setDrawn(k / DRAW_STEPS));
  }, [seen]);

  const fmt = useMemo(() => new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [lang]);
  const pct = (win: number) => `${fmt.format(win * 100)} %`;
  // Each row's line on the right, counting one more line wherever the places skip.
  const placed = useMemo(() => {
    let line = -1;
    let last = 0;
    return rows.map((row, i) => {
      const to = row.to ?? i + 1;
      const gap = i > 0 && to - last > 1;
      line += gap ? 2 : 1;
      last = to;
      return { ...row, to, line, gap };
    });
  }, [rows]);
  const slots = Math.max(placed[placed.length - 1].line + 1, ...rows.map((row) => row.from));
  const height = slots * PITCH;

  const draw = useCallback(
    (cells: Cells) => {
      for (const row of placed) {
        const run = lineCells(0, mid(row.from - 1), gutter - 2, mid(row.line));
        const up = row.to < row.from;
        const shown = Math.ceil(run.length * drawn);
        run.slice(0, shown).forEach(([x, y], k) => {
          if (up) cells.block(x, y - 1, 2, 2, 'fg');
          else if (k % 2 === 0) cells.set(x, y, 'rail');
        });
      }
    },
    [placed, drawn, gutter],
  );

  return (
    <div ref={ref} className={`ar-climb${narrow ? ' narrow' : ''}`} style={{ '--slots': slots } as CSSProperties}>
      <div className="sr-only">
        <table>
          <thead>
            <tr>
              <th scope="col">{t(lang, 'levelWord')}</th>
              {labels.map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {placed.map((row) => (
              <tr key={row.word}>
                <th scope="row">{row.word}</th>
                <td>{row.from}</td>
                <td>{row.to}</td>
                <td>{pct(row.win)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ar-climb-draw" aria-hidden="true">
        <span className="ar-climb-head ar-climb-head-from">{heads[0]}</span>
        <span className="ar-climb-head ar-climb-head-to">{heads[1]}</span>
        <span className="ar-climb-head ar-climb-head-win">{heads[2]}</span>
        <div className="ar-climb-from">
          {placed.map((row) => (
            <span key={row.word} className="board-rank" style={{ gridRow: row.from }}>
              {row.from}
            </span>
          ))}
        </div>
        <div className="ar-climb-lines">
          <CellCanvas cols={gutter} rows={height} draw={draw} />
        </div>
        <ol className="ar-climb-board">
          {placed.map((row) => [
            row.gap && <li key={`${row.word}-gap`} className="board-gap" style={{ gridRow: row.line }} />,
            <li key={row.word} className="board-row ar-climb-row" style={{ gridRow: row.line + 1 }}>
              <BoardRank rank={row.to} />
              <span className="board-name">{row.word}</span>
              <span className="board-score">{pct(row.win)}</span>
            </li>,
          ])}
        </ol>
      </div>
    </div>
  );
}
