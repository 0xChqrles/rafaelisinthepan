import type { GroupStandingState } from '../hooks/useGroupStanding';
import { tStanding } from '../i18n';
import { pathForBoard, type Mode } from '../langs';
import { navigate } from '../routing';
import { useGameStore } from '../state/gameStore';

// Where the player stands TODAY in their group (#271) — ONE line beside the score,
// "2ND OF 7 TODAY", a tap onto that group's board. It replaced the #170 `TOP 25%` badge
// (user-decided 2026-09-07): the anonymous population never showed most players a
// standing at all, and the group is the social unit of this game.
//
// It is ABSOLUTELY placed beside the number (the badge's own `.standing-line` slot), so
// arriving — or never arriving, on a silent failure, while the read is still out, or for
// a player in no group — moves nothing: the score stays centred and the ruler under it
// stays put. A rehydrated result renders settled and replays nothing.
export default function GroupStanding({
  standing,
  mode,
  lang,
  animate = true,
  start = true,
}: {
  standing: GroupStandingState;
  mode: Mode;
  lang: string;
  animate?: boolean;
  start?: boolean;
}) {
  const setLastGroup = useGameStore((s) => s.setLastGroup);
  const settled = !animate;
  if (!(settled || start)) return null;
  if (standing === 'pending' || standing === null) return null;
  const open = () => {
    // The tap opens THAT group's board: the leaderboard reopens on the group last shown.
    setLastGroup(standing.group);
    navigate(pathForBoard(lang, mode));
  };
  return (
    <button
      type="button"
      className={`standing-line${settled ? ' settled' : ' in'}`}
      onClick={open}
    >
      {tStanding(lang, standing.rank, standing.of)}
    </button>
  );
}
