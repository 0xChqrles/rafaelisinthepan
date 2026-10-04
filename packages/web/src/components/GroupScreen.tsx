import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { anonName, defaultAvatar, type BoardPlayer, type GroupSummary } from '@whippin/shared';
import { readGroup } from '../api';
import Avatar from './Avatar';
// (The dissolve's tiles its members come in through: on the document's root.)
import './bayerTiles';
import { LINE_PX, MARK } from './boardMetrics';
import LoadingWave from './LoadingWave';
import CloseIcon from '../assets/icons/close.svg?react';
import ModalHeader from './ModalHeader';
import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// A GROUP'S OWN SCREEN (#271, user-decided 2026-09-14: "managing the group should have
// its own screen"; and the board's three standing buttons — LEAVE, MANAGE, INVITE — "are
// weird… always on screen even if we use them 1% of the time"). Everything there is to DO
// with a group lives here, one tap in from the board (its door over the lines, or the shown
// tab's chip), and the board keeps only its list.
//
// Top to bottom: the app's header row with the way back and the group's name; the MEMBERS as
// the board's own LINES (the mark at 3px a cell, the name — your own framed by the corner
// brackets, as on the board), coming in through the board's Bayer dissolve, the owner tagged
// under their name, and — for the owner — the header's pixel ✕ at every other line's end that
// opens the removal's confirmation; then the screen's one call, INVITE, and under it the quiet
// way out, LEAVE — standing at the screen's foot whatever the group's size: the MEMBERS scroll,
// in whole lines (the room left them floored to the lines' pitch, so a line is never cut at
// rest), and the acts stay in reach. The members are dressed by the group's public face
// (`GET /groups?id=`), the assigned identities standing in until it lands.
//
// A full-screen dialog on flat `--bg` (the selection's shell), so the board under it is
// inert; the confirmations stack over it in the top layer.
// The members come in one after another, a beat after the screen.
const MEMBER_START_MS = 120;
const MEMBER_STAGGER_MS = 40;

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
  const { closing, beginClose, dialogProps } = useModalDismiss('fade-out');
  const owner = group.createdBy === meId;

  const [faces, setFaces] = useState<Record<string, BoardPlayer>>({});
  useEffect(() => {
    const controller = new AbortController();
    void readGroup(group.id, controller.signal).then((read) => {
      if (read.status !== 'shown' || controller.signal.aborted) return;
      setFaces(Object.fromEntries(read.group.members.map((member) => [member.publicId, member])));
    });
    return () => controller.abort();
  }, [group.id, group.members.join(',')]);

  const face = (id: string): BoardPlayer =>
    faces[id] ?? { publicId: id, name: '', avatar: null };

  // The members' room, in whole lines.
  const roomRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<number | null>(null);
  useLayoutEffect(() => {
    const room = roomRef.current;
    if (!room) return undefined;
    const measure = () => setLines(Math.max(1, Math.floor(room.clientHeight / LINE_PX)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(room);
    return () => ro.disconnect();
  }, []);

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog puzzle-select group-screen${closing ? ' closing' : ''}`}
      aria-label={group.name}
      onClose={onClose}
    >
      <ModalHeader lang={lang} title={group.name} back onClose={beginClose} />

      <div className="group-body">
        <div className="board-section">{t(lang, 'groupMembers')}</div>
        <div ref={roomRef} className="group-room">
          <ol className="board-list pixel-scroll" style={lines === null ? undefined : { maxHeight: lines * LINE_PX }}>
            {group.members.map((id, index) => {
              const player = face(id);
              const me = id === meId;
              return (
                <li
                  key={id}
                  className={`board-row member${me ? ' me' : ''}`}
                  style={{ '--delay': `${MEMBER_START_MS + index * MEMBER_STAGGER_MS}ms` } as CSSProperties}
                  aria-current={me || undefined}
                >
                  <Avatar avatar={player.avatar ?? defaultAvatar(id)} size={MARK} sharp />
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
                      <CloseIcon className="ui-icon" aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

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
