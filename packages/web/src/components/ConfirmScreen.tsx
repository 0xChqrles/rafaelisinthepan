import type { ReactNode } from 'react';
import useModalDismiss from '../hooks/useModalDismiss';
// (For its side effect: the root's Bayer tiles the screen comes and goes through.)
import './bayerTiles';
import BusyButton from './BusyButton';
import ScreenFrame from './ScreenFrame';
import { t } from '../i18n';

// The app's CONFIRMATION surface for an act that takes something away (#271, user-decided
// 2026-09-14: "for such an important action, we actually need a fullscreen modal — to remove
// people you click the cross, then confirm in the modal; and same to leave the group"; the
// give-up wears it too). It replaced the two-tap confirms the group board shipped with (a
// control changing its own word to LEAVE? / REMOVE?): a word swap is easy to tap through.
//
// It is the ERROR SCREEN's shape — the whole screen in the full-screen moment's frame (the
// corners and the lockup, `ScreenFrame`), in through the Bayer dissolve and out the same way —
// because the two are the app's two full-screen messages. What differs is the voice: no bot,
// the title in the plain ink (nothing has gone wrong yet), and on the bottom edge TWO ways
// out where the error has one, in the signed-out screen's geometry: the act itself in the
// QUIET DANGER dress (destruction never glows, so the lit primary is never the button that
// removes somebody) with CANCEL as THE WORD under it. The caller draws WHAT is at stake above
// the title (`children`: a member's face, the group's name, the ∞ a give-up prints), may set a
// CHOICE under the note — read after the question it answers (`choice`: the owner's successor
// pick) — and may hold the act back until the choice is made (`disabled`).
//
// Follows the modal rules (`useModalDismiss`): opening focuses the dialog, Escape leaves
// through the same exit, a backdrop tap is nothing (there is none).
export default function ConfirmScreen({
  lang,
  title,
  note,
  action,
  busy = false,
  disabled = false,
  children,
  choice,
  onConfirm,
  onClose,
}: {
  lang: string;
  // WHAT is about to happen, in the chrome voice.
  title: string;
  // What it means — a sentence, sentence case.
  note: string;
  // The act's own word (REMOVE, LEAVE).
  action: string;
  // The act is in flight: the button is busy (`BusyButton`), nothing else answers.
  busy?: boolean;
  // The act is not answerable yet (the choice is still open).
  disabled?: boolean;
  children?: ReactNode;
  // What the act needs chosen first, under the note.
  choice?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('board-dissolve-out');

  return (
    <dialog
      {...dialogProps}
      className={`error-screen confirm-screen${closing ? ' closing' : ''}`}
      aria-label={title}
      onClose={onClose}
    >
      <ScreenFrame />
      <div className="error-body">
        {children}
        <p className="error-title">{title}</p>
        <p className="error-note">{note}</p>
        {choice}
      </div>
      <div className="error-calls">
        <BusyButton
          className="btn btn-secondary btn-danger"
          lang={lang}
          busy={busy}
          disabled={disabled}
          onClick={onConfirm}
        >
          {action}
        </BusyButton>
        <button type="button" className="link-quiet-btn" disabled={busy} onClick={beginClose}>
          {t(lang, 'linkCancel')}
        </button>
      </div>
    </dialog>
  );
}
