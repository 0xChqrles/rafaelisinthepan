import BracketSwitch from '../../../components/BracketSwitch';

// A figure's two (or more) states, as the article's own AVANT / APRÈS — on the board's own
// switch (`BracketSwitch`, a group's TODAY / WEEK / MONTH): equal cells in resting corner
// brackets, the shown one under the white frame that travels to the state turned to. Pressed
// buttons, not tabs: the figure announces what changed itself.
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
    <div className="ar-switch" role="group">
      <BracketSwitch labels={labels} shown={active} onPick={onPick} pressed />
    </div>
  );
}
