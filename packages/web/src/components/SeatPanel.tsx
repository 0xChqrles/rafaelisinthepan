// THE SEAT (the result's boards, `ResultBoards`): the panel of the tab a player none of whose
// groups holds anybody else is shown first — the board they would have. Their own line, in the
// boards' one dress but with nothing to claim (no rank, no %, no frame: nobody is there to tell
// it apart from, and the brackets are the act's), then the line where a friend would stand,
// holding the ACT: the pixel plus and CREATE GROUP — or, in a group of one, INVITE — as the
// bracketed quiet word (SIGN OUT's dress), the panel's one tappable-looking thing.
//
// THE PANEL KEEPS THE BOX'S GRAMMAR: a tap on it opens the board, like every tab's (the caller's
// `panel` props: the swipe, the tap onto the board — its group tab, where NO GROUP and its CREATE
// GROUP, or the group of one and its INVITE, already stand). ONLY THE CALL does the act, IN PLACE:
// CREATE GROUP raises the board's own naming screen (`GroupCreate`) over the result, which folds
// back onto the seat already on the new group (named on its tab, INVITE on its call — drawn under
// the screen as it closes, nothing replayed); INVITE shares the group's `/g/<id>` link — a fresh
// tap of its own, which iPhone needs for the sheet. Both are the board's own acts
// (`state/groupActs.ts`): a refused name or the cap answers at the naming screen's line, and what
// does not land speaks on the app's error surface. No analytics event (`tracked: false`).
//
// What it raises over the result stands OUTSIDE the panel in the React tree — an event bubbles
// through a portal to its React parents, so a tap inside either would otherwise be the panel's
// tap — and the error surface is portaled to the body, so the box's hidden-until-its-beat and
// inert-until-armed never reach it (the naming screen portals itself).
import type { CSSProperties, HTMLAttributes, MouseEvent } from 'react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { GroupSummary, PlayingRow } from '@whippin/shared';
import { PlayingRowItem } from './BoardRows';
import ErrorScreen from './ErrorScreen';
import GroupCreate from './GroupCreate';
import PlusIcon from '../assets/icons/plus.svg?react';
import useShare from '../hooks/useShare';
import { identityEpochOf, useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import { useGameStore } from '../state/gameStore';
import {
  createGroup,
  createVerdictOf,
  failureOf,
  groupFailureCopy,
  inviteText,
  type CreateVerdict,
  type GroupFailure,
} from '../state/groupActs';

export default function SeatPanel({
  lang,
  group,
  own,
  panel,
  swiped,
}: {
  lang: string;
  // The player's group of one, or null with no group at all.
  group: GroupSummary | null;
  // Their own line (`ownRow`).
  own: PlayingRow;
  // The tab's panel, as the box draws every one: its tabpanel wiring, the swipe, the tap onto
  // the board.
  panel: HTMLAttributes<HTMLDivElement>;
  // Whether a swipe ended on the click just now (`useSwipe`): it opens nothing, the call
  // included.
  swiped: (e: MouseEvent) => boolean;
}) {
  const identity = useDeviceIdentity();
  const setLastGroup = useGameStore((s) => s.setLastGroup);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<GroupFailure | null>(null);
  const { share, copied } = useShare({ tracked: false });

  // The board's create, from here: the write publishes the list, so the seat is on the new
  // group (and the crown's board, and tomorrow's result) before the naming screen folds. The
  // box only stands for an account, and this tap never makes one.
  const create = async (name: string): Promise<CreateVerdict> => {
    if (busy || identity === null) return 'other';
    setBusy(true);
    setFailure(null);
    const write = await createGroup(identityEpochOf(identity), name);
    setBusy(false);
    if (write.kind === 'done' && write.created) setLastGroup(write.created);
    setFailure(failureOf('create', write));
    return createVerdictOf(write);
  };

  const invite = async (id: string) => {
    setFailure(null);
    if (!(await share(inviteText(lang, window.location.origin, id)))) setFailure('share');
  };

  const call = (e: MouseEvent) => {
    // The panel's own tap opens the board: the call's goes no further.
    e.stopPropagation();
    if (swiped(e)) return;
    if (group) void invite(group.id);
    else setCreating(true);
  };

  return (
    <>
      <div className="result-board seats" {...panel}>
        <ol className="board-list">
          <PlayingRowItem row={own} me lang={lang} index={0} />
          <li>
            <button
              type="button"
              className="board-row board-seat call"
              style={{ '--i': 1 } as CSSProperties}
              onClick={call}
            >
              <span className="board-norank" aria-hidden="true" />
              <span className="board-seat-plus" aria-hidden="true">
                <PlusIcon className="ui-icon" />
              </span>
              <span className="quiet-btn board-seat-say" data-focus-box>
                {group ? t(lang, copied ? 'copied' : 'boardInvite') : t(lang, 'groupCreate')}
              </span>
            </button>
          </li>
        </ol>
      </div>
      {creating && (
        <GroupCreate lang={lang} busy={busy} onCreate={create} onClose={() => setCreating(false)} />
      )}
      {failure !== null &&
        createPortal(
          <ErrorScreen lang={lang} {...groupFailureCopy(lang, failure)} onClose={() => setFailure(null)} />,
          document.body,
        )}
    </>
  );
}
