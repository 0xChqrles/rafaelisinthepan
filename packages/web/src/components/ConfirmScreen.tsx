import type { ReactNode } from 'react';
import useModalDismiss from '../hooks/useModalDismiss';
import LoadingWave from './LoadingWave';
import { t } from '../i18n';

// The app's CONFIRMATION surface for an act that takes something away from somebody
// (#271, user-decided 2026-09-14: "for such an important action, we actually need a
// fullscreen modal — to remove people you click the cross, then confirm in the modal; and
// same to leave the group"). It replaced the two-tap confirms the group board shipped with
// (a control changing its own word to LEAVE? / REMOVE? and acting on the second tap): a
// word swap is easy to tap through, and a member shown out of a group is not a state a
// second tap can undo.
//
// It is the ERROR SCREEN's shape — the whole screen, on flat `--bg`, one narrow column —
// because the two are the app's two full-screen messages and should be one shape (the
// SignedOut / NoPuzzle language). What differs is the voice: no bot, the title in the
// plain ink (nothing has gone wrong yet), and TWO ways out where the error has one — the
// act itself, in the QUIET DANGER dress (the account area's rule: destruction never glows,
// so the lit primary is never the button that removes somebody), and CANCEL, a plain
// secondary. The caller draws WHO or WHAT is at stake above the title (`children`) and may
// hold the act back until a choice is made (`disabled` — the owner's successor pick).
//
// Follows the modal rules (`useModalDismiss`): opening focuses the dialog, Escape leaves
// through the `error-out` beat, a backdrop tap is nothing (there is none).
export default function ConfirmScreen({
  lang,
  title,
  note,
  action,
  busy = false,
  disabled = false,
  children,
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
  // The act is in flight: the button holds its loading state, nothing else answers.
  busy?: boolean;
  // The act is not answerable yet (a choice above it is still open).
  disabled?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('error-out');

  return (
    <dialog
      {...dialogProps}
      className={`error-screen confirm-screen${closing ? ' closing' : ''}`}
      aria-label={title}
      onClose={onClose}
    >
      <div className="error-body">
        {children}
        <p className="error-title">{title}</p>
        <p className="error-note">{note}</p>
        <button
          type="button"
          className="btn btn-secondary btn-danger"
          disabled={busy || disabled}
          onClick={onConfirm}
        >
          {busy ? <LoadingWave text={t(lang, 'loading')} /> : action}
        </button>
        <button type="button" className="link-quiet-btn" disabled={busy} onClick={beginClose}>
          {t(lang, 'linkCancel')}
        </button>
      </div>
    </dialog>
  );
}
