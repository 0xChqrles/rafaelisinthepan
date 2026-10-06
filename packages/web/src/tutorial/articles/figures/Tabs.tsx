import { useRef } from 'react';
import BracketSwitch from '../../../components/BracketSwitch';
import useSeen from './useSeen';

// A figure's two (or more) states, as the article's own AVANT / APRÈS — on the board's own
// switch (`BracketSwitch`, a group's TODAY / WEEK / MONTH): equal cells in resting corner
// brackets, the shown one under the white frame that travels to the state turned to. Pressed
// buttons, not tabs: the figure announces what changed itself. The frame LOCKS ON once the
// figure is on screen (its lock held on its first frame until then, CSS), not at mount.
export default function Tabs({
  labels,
  active,
  onPick,
}: {
  labels: string[];
  active: number;
  onPick: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  return (
    <div ref={ref} className={`ar-switch${seen ? ' seen' : ''}`} role="group">
      <BracketSwitch labels={labels} shown={active} onPick={onPick} pressed />
    </div>
  );
}
