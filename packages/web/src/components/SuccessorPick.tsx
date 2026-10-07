import { anonName, defaultAvatar, type BoardPlayer } from '@whippin/shared';
import Avatar from './Avatar';
import { MARK } from './boardMetrics';
import useMoreBelow from '../hooks/useMoreBelow';
import { t } from '../i18n';

// WHO TAKES A GROUP OVER (#271's succession rule, the owner of three or more leaving): the
// other members as the board's LINES, radios, set under the leave's question. Each line rests
// in the slate corners of a thing to tap, the one picked locks on in white — the brackets, the
// house's selection gesture. The list scrolls in whole lines, and while lines lie below its
// foot (`useMoreBelow`'s `data-more`) the ones passing there thin out through the dither.
export default function SuccessorPick({
  lang,
  members,
  faces,
  picked,
  onPick,
}: {
  lang: string;
  // The candidates' public ids, in the group's order.
  members: readonly string[];
  // Their faces as the group read dressed them (a missing one draws the assigned identity).
  faces: Readonly<Record<string, BoardPlayer>>;
  picked: string | null;
  onPick: (publicId: string) => void;
}) {
  const [list, more] = useMoreBelow<HTMLDivElement>();

  return (
    <div
      ref={list}
      className="board-list confirm-pick"
      data-more={more || undefined}
      role="radiogroup"
      aria-label={t(lang, 'groupMembers')}
    >
      {members.map((id) => {
        const face = faces[id];
        const on = picked === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            className={`board-row member${on ? ' picked' : ''}`}
            onClick={() => onPick(id)}
          >
            <Avatar avatar={face?.avatar ?? defaultAvatar(id)} size={MARK} sharp />
            <span className={`board-name${face?.name ? '' : ' anon'}`}>{face?.name || anonName(id)}</span>
          </button>
        );
      })}
    </div>
  );
}
