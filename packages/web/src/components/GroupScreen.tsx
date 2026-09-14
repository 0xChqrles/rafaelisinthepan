import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { anonName, defaultAvatar, type BoardPlayer, type GroupSummary } from '@whippin/shared';
import { readGroup } from '../api';
import Avatar from './Avatar';
import LoadingWave from './LoadingWave';
import { HeaderBack } from './TopBar';
import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// A GROUP'S OWN SCREEN (#271, user-decided 2026-09-14: "managing the group should have
// its own screen"; and the board's three standing buttons — LEAVE, MANAGE, INVITE — "are
// weird… always on screen even if we use them 1% of the time"). Everything there is to DO
// with a group lives here, one tap in from the board's pager, and the board keeps only
// its list.
//
// Top to bottom: the app's header row with the way back and the group's name as the held
// word; the MEMBERS as the board's own rows (mark + name), the owner tagged, and — for the
// owner — a ✕ at every other row's end that opens the removal's confirmation; then the
// screen's one call, INVITE, and under it the quiet way out, LEAVE. The members are
// dressed by the group's public face (`GET /groups?id=`), the assigned identities standing
// in until it lands.
//
// A full-screen dialog on flat `--bg` (the selection's shell), so the board under it is
// inert; the confirmations stack over it in the top layer.
export default function GroupScreen({
  lang,
  group,
  meId,
  busy,
  copied,
  onInvite,
  onRemove,
  onLeave,
  onClose,
}: {
  lang: LangCode;
  group: GroupSummary;
  meId: string | null;
  busy: boolean;
  copied: boolean;
  onInvite: () => void;
  onRemove: (member: BoardPlayer) => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('select-out');
  const owner = group.createdBy === meId;

  const [faces, setFaces] = useState<Record<string, BoardPlayer>>({});
  useEffect(() => {
    const controller = new AbortController();
    void readGroup(group.id, controller.signal).then((read) => {
      if (read.status !== 'shown' || controller.signal.aborted) return;
      setFaces(Object.fromEntries(read.group.members.map((member) => [member.publicId, member])));
    });
    return () => controller.abort();
  }, [group.id, group.members.length]);

  const face = (id: string): BoardPlayer =>
    faces[id] ?? { publicId: id, name: '', avatar: null };

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog puzzle-select group-screen${closing ? ' closing' : ''}`}
      aria-label={group.name}
      onClose={onClose}
    >
      <div className="modal-bar">
        <div className="topbar-inner">
          <div className="topbar-left">
            <HeaderBack
              label={t(lang, 'ariaClose')}
              onBack={() => {
                if (!closing) beginClose();
              }}
            />
            <span className="topbar-title">{group.name}</span>
          </div>
          <div className="topbar-right" />
        </div>
      </div>

      <div className="group-body pixel-scroll">
        <div className="board-section">{t(lang, 'groupMembers')}</div>
        <ol className="board-list group-members">
          {group.members.map((id, index) => {
            const player = face(id);
            const me = id === meId;
            return (
              <li
                key={id}
                className={`board-row member${me ? ' me' : ''}`}
                style={{ '--i': index } as CSSProperties}
                aria-current={me || undefined}
              >
                <Avatar avatar={player.avatar ?? defaultAvatar(id)} size={28} />
                <span className="board-ident">
                  <span className={`board-name${player.name ? '' : ' anon'}`}>{player.name || anonName(id)}</span>
                  {id === group.createdBy && <span className="board-detail">{t(lang, 'groupOwnerTag')}</span>}
                </span>
                {owner && !me && (
                  <button
                    type="button"
                    className="board-remove"
                    aria-label={t(lang, 'groupRemove')}
                    disabled={busy}
                    onClick={() => onRemove(player)}
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ol>

        <div className="group-calls">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onInvite}>
            {busy ? <LoadingWave text={t(lang, 'loading')} /> : copied ? t(lang, 'copied') : t(lang, 'boardInvite')}
          </button>
          <button type="button" className="link-quiet-btn link-danger" disabled={busy} onClick={onLeave}>
            {t(lang, 'groupLeave')}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
