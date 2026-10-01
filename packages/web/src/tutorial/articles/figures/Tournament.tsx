import type { CSSProperties } from 'react';
import { rankHeatColor } from '@whippin/shared';
import { t } from '../../../i18n';
import { useArticleLang } from '../lang';

// THE TOP OF A REAL TOURNAMENT, DRAWN AS A CLIMB: on the left each word's place by its grade,
// on the right its place once the tournament is over, a line from one to the other — white
// where the word climbs, muted where it holds or falls — then its mean win probability, the
// reason it moved. Both places are bare ranks in the sentence's heat. A row whose place skips
// ahead (`to`) is set apart by a gap. Screen readers get the same figures as a table.
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
  const pct = new Intl.NumberFormat(lang, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // Each row's line on the right, counting one more line wherever the places skip.
  let line = -1;
  let last = 0;
  const placed = rows.map((row, i) => {
    const to = row.to ?? i + 1;
    const gap = i > 0 && to - last > 1;
    line += gap ? 2 : 1;
    last = to;
    return { ...row, to, line, gap };
  });
  const slots = Math.max(line + 1, ...rows.map((row) => row.from));
  return (
    <div className="ar-climb" style={{ '--slots': slots } as CSSProperties}>
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
                <td>{pct.format(row.win)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ar-climb-draw" aria-hidden="true">
        <span className="ar-climb-head ar-climb-head-from">{heads[0]}</span>
        <span className="ar-climb-head ar-climb-head-to">{heads[1]}</span>
        <span className="ar-climb-head ar-climb-head-win">{heads[2]}</span>
        {placed.map((row) => (
          <span
            key={row.word}
            className="ar-climb-from"
            style={{ gridRow: row.from + 1, '--rank-color': rankHeatColor(row.from) } as CSSProperties}
          >
            {row.from}
          </span>
        ))}
        <svg className="ar-climb-lines" viewBox={`0 0 100 ${slots}`} preserveAspectRatio="none">
          {placed.map((row) => (
            <line
              key={row.word}
              className={row.to < row.from ? 'up' : undefined}
              x1="0"
              y1={row.from - 0.5}
              x2="100"
              y2={row.line + 0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {placed.map((row) => [
          row.gap && (
            <span key={`${row.word}-gap`} className="ar-climb-gap" style={{ gridRow: row.line + 1 }}>
              …
            </span>
          ),
          <div key={row.word} className="ar-climb-row" style={{ gridRow: row.line + 2 }}>
            <span className="ar-climb-to" style={{ '--rank-color': rankHeatColor(row.to) } as CSSProperties}>
              {row.to}
            </span>
            <span className="ar-climb-word">{row.word}</span>
            <span className="ar-climb-win">{pct.format(row.win)}</span>
          </div>,
        ])}
      </div>
    </div>
  );
}
