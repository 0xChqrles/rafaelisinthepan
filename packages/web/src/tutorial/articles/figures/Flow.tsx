// TWO PIPELINES, SIDE BY SIDE: the same reading, a different end — each step a box, the
// steps where the two part ways marked. Row-aligned, so step n of one sits beside step n of
// the other.
export default function Flow({ rows }: { rows: { name: string; steps: string[]; marked?: number[] }[] }) {
  const depth = Math.max(...rows.map((r) => r.steps.length));
  return (
    <div className="ar-flow" style={{ gridTemplateColumns: `repeat(${rows.length}, 1fr)` }}>
      {rows.map((row) => (
        <p key={row.name} className="ar-flow-name">
          {row.name}
        </p>
      ))}
      {Array.from({ length: depth }, (_, i) =>
        rows.map((row) => {
          const step = row.steps[i];
          return (
            <div
              key={`${row.name}-${i}`}
              className={`ar-flow-step${row.marked?.includes(i) ? ' marked' : ''}${i === row.steps.length - 1 ? ' last' : ''}`}
            >
              {step ?? ''}
            </div>
          );
        }),
      )}
    </div>
  );
}
