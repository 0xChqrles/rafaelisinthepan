import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';
import CloseIcon from '../assets/icons/close.svg?react';

// The app's ONE error surface for a PRIMARY ACTION that failed (#216 trigger rework,
// user-decided 2026-08-24): a centered popup on desktop, a bottom sheet on a phone (the
// CSS decides by width — the same ≤640px step every other chrome takes). It says WHAT
// happened in a sentence and, when asking again can help, offers TRY AGAIN; the close
// chip and Escape dismiss either way.
//
// It exists for the five account-deploying buttons — the two PLAY gates, the invite
// accept, the invite send, the profile save — whose failures used to be inline lines
// with as many spellings as surfaces. A LOAD that failed keeps `LoadError`: that is a
// screen that could not open, where this is an ACT that did not land.
//
// Follows the modal rules (`useModalDismiss`) for DISMISSAL: opening focuses the dialog,
// a backdrop tap is not one, the close chip and Escape leave through the `error-out` exit
// beat. **TRY AGAIN is the deliberate exception (PR-219 round-2 review, P1): it fires
// SYNCHRONOUSLY inside its own tap.** The retried act may need the tap's transient user
// activation — WebKit refuses a clipboard write (and the spec a native share) reached
// across an async boundary, so a retry deferred to the exit animation could NEVER deliver
// on Safari: the sheet would reopen on every tap, forever. The button calls `onClose()`
// then `onRetry()` in the click's own tick — the owner's state change unmounts the sheet
// (no exit beat; an open dialog unmounts cleanly), and a retry that fails again mounts a
// fresh one, which is itself the honest feedback.
export default function ErrorSheet({
  lang,
  title,
  note,
  onRetry,
  onClose,
}: {
  lang: string;
  // WHAT failed, in the chrome voice (all-caps, localized upstream).
  title: string;
  // What happened and what to do about it — a sentence, not a code.
  note: string;
  // Present only when asking again can help; its absence means the note is the answer.
  // MUST begin its activation-dependent work synchronously (see above): the sheet
  // guarantees the call happens inside the tap, and the handler must not spend that on
  // an await of its own before the delivery API.
  onRetry?: () => void;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('error-out');

  return (
    <dialog
      {...dialogProps}
      className={`error-dialog${closing ? ' closing' : ''}`}
      aria-label={title}
      onClose={onClose}
    >
      <button
        type="button"
        className="home-btn error-close"
        aria-label={t(lang, 'ariaClose')}
        onClick={beginClose}
      >
        <CloseIcon className="ui-icon" aria-hidden />
      </button>
      <p className="error-title">{title}</p>
      <p className="error-note">{note}</p>
      {onRetry && (
        <button
          type="button"
          className="mix-btn error-retry"
          onClick={() => {
            // Order matters: the owner clears its failed state first (the unmount), and
            // the retry starts second — still the same synchronous tick, so the whole
            // chain down to the delivery API runs inside this tap's activation.
            onClose();
            onRetry();
          }}
        >
          {t(lang, 'tryAgain')}
        </button>
      )}
    </dialog>
  );
}
