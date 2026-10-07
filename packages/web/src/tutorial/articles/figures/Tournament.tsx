import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { UI_ADVANCE_EM } from '@whippin/shared';
import { BoardRank } from '../../../components/BoardRows';
import { LINE_PX, rankColumnPx } from '../../../components/boardMetrics';
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
//
// THE LINES' GUTTER is a quarter of the figure — wide enough that a climb of four places reads
// as a line CROSSING the others, never a slash — less only what the longest word and its
// probability need to stand whole: where that leaves under a fifth, the words step down a size
// (`NAME_PX`) before the gutter gives more. On a phone's column the probability's figures are
// 8px and the row's gaps tighter.
const NAME_PX = [15, 13, 12, 11];
const GUTTER_SHARE = 1 / 4;
const GUTTER_FLOOR_SHARE = 1 / 5;
const MIN_GUTTER_CELLS = 12;
// Under this width (the figure's own), the phone's dress.
const PHONE_PX = 520;
// Air kept past the longest word.
const NAME_AIR = 4;
// A line's pitch in cells, and the cell row through a slot's middle.
const PITCH = LINE_PX / CELL;
const mid = (slot: number) => Math.round((slot + 0.5) * PITCH);
const DRAW_STEPS = 8;
const DRAW_MS = 420;

// The figure's dress for its width: the columns, the gaps, the sizes and the gutter in cells.
function dressFor(width: number, longest: number, pctGlyphs: number, rankW: number) {
  const phone = width < PHONE_PX;
  const fromW = phone ? 20 : 24;
  const gap = phone ? 8 : 12;
  const scorePx = phone ? 8 : 16;
  const fixed = fromW + rankW + 2 * gap + pctGlyphs * scorePx;
  let namePx = NAME_PX[0];
  let room = 0;
  for (const px of NAME_PX) {
    namePx = px;
    room = width - fixed - Math.ceil(longest * UI_ADVANCE_EM * px) - NAME_AIR;
    if (room >= width * GUTTER_FLOOR_SHARE) break;
  }
  const gutter = Math.max(MIN_GUTTER_CELLS, Math.floor(Math.min(width * GUTTER_SHARE, room) / CELL));
  return { fromW, gap, scorePx, namePx, gutter };
}

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
  const rankW = rankColumnPx(String(Math.max(...placed.map((row) => row.to))).length);
  const { fromW, gap, scorePx, namePx, gutter } = dressFor(
    width,
    Math.max(...rows.map((row) => row.word.length)),
    Math.max(...rows.map((row) => pct(row.win).length)),
    rankW,
  );

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
    <div
      ref={ref}
      className="ar-climb"
      style={
        {
          '--slots': slots,
          '--from-w': `${fromW}px`,
          '--gutter-w': `${gutter * CELL}px`,
          '--rank-w': `${rankW}px`,
          '--row-gap': `${gap}px`,
          '--name-px': `${namePx}px`,
          '--score-px': `${scorePx}px`,
        } as CSSProperties
      }
    >
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
