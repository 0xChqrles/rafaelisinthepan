import { t } from '../../../i18n';
import { useArticleLang } from '../lang';

// TWO PIPELINES, SIDE BY SIDE: the same reading, a different end. Each pipeline is a column of
// its steps, each a note in a sentence, one after the other down the floor's stipple stood up
// (the rail between two steps), and the steps where the two part ways wear the WHITE TITLE CHIP, the
// one emphasis gesture. Row-aligned on one grid (step n of one beside step n of the other), but
// written COLUMN BY COLUMN, so it is read one pipeline at a time: each is a list named after its
// pipeline, its cells placed on the grid explicitly.
export default function Flow({ rows }: { rows: { name: string; steps: string[]; marked?: number[] }[] }) {
  const lang = useArticleLang();
  return (
    <div className="ar-flow" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
      {rows.map((row, c) => (
        <div key={row.name} className="ar-flow-col" role="list" aria-label={row.name}>
          <p className="ar-flow-name" style={{ gridColumn: c + 1, gridRow: 1 }} aria-hidden="true">
            {row.name}
          </p>
          {row.steps.map((step, i) => {
            const marked = row.marked?.includes(i);
            return (
              <div
                // Static per figure: the index is a stable key.
                key={i}
                role="listitem"
                className={`ar-flow-step${i === 0 ? ' first' : ''}${i === row.steps.length - 1 ? ' last' : ''}`}
                style={{ gridColumn: c + 1, gridRow: i + 2 }}
              >
                <span className={`ar-flow-text${marked ? ' marked' : ''}`}>{step}</span>
                {marked && <span className="sr-only">{` (${t(lang, 'levelMarkDiffers')})`}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
