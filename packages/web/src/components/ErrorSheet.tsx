import { useRef } from 'react';
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
// Follows the modal rules (`useModalDismiss`): opening focuses the dialog, a backdrop
// tap is not a dismissal, closing is a beat behind the `error-out` exit animation. The
// TRY AGAIN button goes through the same exit and fires `onRetry` once the dialog has
// actually closed, so the retried action never runs under a half-dismissed sheet.
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
  onRetry?: () => void;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('error-out');
  const retryArmed = useRef(false);

  return (
    <dialog
      {...dialogProps}
      className={`error-dialog${closing ? ' closing' : ''}`}
      aria-label={title}
      onClose={() => {
        const retry = retryArmed.current;
        retryArmed.current = false;
        onClose();
        if (retry) onRetry?.();
      }}
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
            retryArmed.current = true;
            beginClose();
          }}
        >
          {t(lang, 'tryAgain')}
        </button>
      )}
    </dialog>
  );
}
