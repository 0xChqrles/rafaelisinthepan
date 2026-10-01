import type { CSSProperties } from 'react';
import { rankHeatColor } from '@whippin/shared';
import { t } from '../../../i18n';
import { useArticleLang } from '../lang';

// THE TOP OF A REAL TOURNAMENT: each word's place by its grade, its mean win probability
// over its 199 duels, and the place the tournament gives it — the sentence's exponent
// colours on both ends, so the climb reads as the game would print it.
export default function Tournament({
  rows,
  labels,
}: {
  rows: { word: string; from: number; win: number }[];
  labels: [string, string, string];
}) {
  const lang = useArticleLang();
  const num = new Intl.NumberFormat(lang);
  const pct = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 });
  return (
    <table className="ar-tourney">
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">{t(lang, 'levelWord')}</span>
          </th>
          <th scope="col">{labels[0]}</th>
          <th scope="col" className="ar-tourney-win-head">
            {labels[1]}
          </th>
          <th scope="col">{labels[2]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.word}>
            <th scope="row" className="ar-tourney-word">
              {row.word}
            </th>
            <td className="ar-tourney-from" style={{ '--rank-color': rankHeatColor(row.from) } as CSSProperties}>
              {num.format(row.from)}
            </td>
            <td className="ar-tourney-win">
              <span className="ar-tourney-bar" style={{ '--w': row.win } as CSSProperties} />
              <span>{pct.format(row.win)}</span>
            </td>
            <td className="ar-tourney-to" style={{ '--rank-color': rankHeatColor(i + 1) } as CSSProperties}>
              {i + 1}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
