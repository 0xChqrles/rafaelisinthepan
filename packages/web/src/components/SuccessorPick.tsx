import { useCallback, useEffect, useRef, useState } from 'react';
import { anonName, defaultAvatar, type BoardPlayer } from '@whippin/shared';
import Avatar from './Avatar';
import { MARK } from './boardMetrics';
import { t } from '../i18n';

// WHO TAKES A GROUP OVER (#271's succession rule, the owner of three or more leaving): the
// other members as the board's LINES, radios, set under the leave's question. Each line rests
// in the slate corners of a thing to tap, the one picked locks on in white — the brackets, the
// house's selection gesture. The list scrolls in whole lines, and while lines lie below its
// foot the ones passing there thin out through the dither (`more`), so a list cut at a line
// still says there is more of it.
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
  const list = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const read = useCallback(() => {
    const el = list.current;
    setMore(el !== null && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);
  // Read again whenever the list's box changes — the dialog opening it, a resize — and when its
  // lines do.
  useEffect(() => {
    const el = list.current;
    read();
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [read, members.length]);

  return (
    <div
      ref={list}
      className={`board-list confirm-pick${more ? ' more' : ''}`}
      role="radiogroup"
      aria-label={t(lang, 'groupMembers')}
      onScroll={read}
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
