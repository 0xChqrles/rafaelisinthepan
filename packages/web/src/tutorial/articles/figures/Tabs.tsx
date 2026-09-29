// A figure's two (or more) states, as the article's own AVANT / APRÈS: a row of labels, the
// shown one underlined. Chrome, so the mono voice in capitals.
export default function Tabs({
  labels,
  active,
  onPick,
}: {
  labels: string[];
  active: number;
  onPick: (i: number) => void;
}) {
  return (
    <div className="ar-tabs" role="tablist">
      {labels.map((label, i) => (
        <button
          key={label}
          type="button"
          role="tab"
          aria-selected={i === active}
          className={`ar-tab${i === active ? ' on' : ''}`}
          onClick={() => onPick(i)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
