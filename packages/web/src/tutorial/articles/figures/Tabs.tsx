// A figure's two (or more) states, as the article's own AVANT / APRÈS: a row of labels, the
// shown one underlined. Pressed-state buttons, not tabs (the profile's palette swatches'
// pattern): each is a plain button, and the figure announces what changed itself.
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
    <div className="ar-tabs" role="group">
      {labels.map((label, i) => (
        <button
          key={label}
          type="button"
          aria-pressed={i === active}
          className={`ar-tab${i === active ? ' on' : ''}`}
          onClick={() => onPick(i)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
