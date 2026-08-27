import useModalDismiss from '../hooks/useModalDismiss';
import Button from './Button';
import { t } from '../i18n';
import botIdle from '../assets/error-bot-idle.png';

// The app's ONE error surface for a PRIMARY ACTION that failed (#216 trigger rework,
// user-decided 2026-08-24). It exists for the five account-deploying buttons — the two PLAY
// gates, the invite accept, the invite send, the profile save — plus the profile editor's two
// moderation refusals, whose failures used to be inline lines with as many spellings as
// surfaces. A LOAD that failed keeps `LoadError`: that is a screen that could not open, where
// this is an ACT that did not land.
//
// **IT IS A FULL-SCREEN MODAL, NOT A SHEET (user-decided 2026-08-27).** It shipped as a
// centred popup on desktop and a bottom sheet on a phone, and that was the wrong FORMAT for
// what this box does: a sheet is the dismissal gesture's own shape — it slides up from the
// edge and asks to be swiped away — while every message here is a CALL TO ACTION. The
// account one is the sharpest case: the account is what PLAY deploys, so a player who
// dismisses it has not tidied a notification away, they have declined to play. A surface
// that reads as disposable cannot carry that. So it takes the whole screen and leads with
// its action.
//
// **THE MESSENGER IS THE ERROR BOT (user-drawn, 2026-08-27), and it SPEAKS the error.** A
// big fail cross was the first cut and it was replaced the same day: a cross is a verdict
// stamped ON the player, where a character delivering bad news is the game's own voice —
// the app already talks to you through the coach box and the pixel ghost, and this is the
// one screen that only ever appears when something went wrong. `error-bot-idle.png` is a
// 4-frame 32x32 idle bob, and `error-speech-ballon.png` is the balloon it speaks through —
// outline, ERROR !, starbursts and tail, all drawn (user-decided 2026-08-27, replacing a
// CSS rebuild of the same shape around live Press Start 2P text: the art is one file and
// one integer scale, where the rebuild was four clip-path layers to say a fixed word).
//
// The stack, top to bottom: the bot saying ERROR ! · WHAT failed (chrome voice, all-caps,
// in the danger ink) · what happened and what to do about it (coach voice — sentence case,
// the one mono surface the all-caps rule exempts, because it explains rather than labels) ·
// the ACTION.
// The primary button is TRY AGAIN wherever asking again can help; where it cannot (the
// moderation refusals — the same name will be refused the same way) the note IS the answer
// and the one button is the way out, so it takes the primary slot rather than leaving the
// screen with nothing to press.
//
// Follows the modal rules (`useModalDismiss`) for DISMISSAL: opening focuses the dialog, a
// backdrop tap is not one (there is no backdrop left to tap), and Escape leaves through the
// `error-out` exit beat. **TRY AGAIN is the deliberate exception (PR-219 round-2 review,
// P1): it fires SYNCHRONOUSLY inside its own tap.** The retried act may need the tap's
// transient user activation — WebKit refuses a clipboard write (and the spec a native share)
// reached across an async boundary, so a retry deferred to the exit animation could NEVER
// deliver on Safari: the screen would reopen on every tap, forever. The button calls
// `onClose()` then `onRetry()` in the click's own tick — the owner's state change unmounts
// the dialog (no exit beat; an open dialog unmounts cleanly), and a retry that fails again
// mounts a fresh one, which is itself the honest feedback.
export default function ErrorScreen({
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
  // MUST begin its activation-dependent work synchronously (see above): the screen
  // guarantees the call happens inside the tap, and the handler must not spend that on
  // an await of its own before the delivery API.
  onRetry?: () => void;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('error-out');

  return (
    <dialog
      {...dialogProps}
      className={`error-screen${closing ? ' closing' : ''}`}
      aria-label={title}
      onClose={onClose}
    >
      <div className="error-body">
        {/* Decorative: the balloon says ERROR, the TITLE below says what actually failed,
            and a reader hearing both would hear the bad news twice. */}
        <div className="error-bot" aria-hidden>
          <div className="error-balloon" />
          <div className="error-bot-sprite" style={{ backgroundImage: `url(${botIdle})` }} />
        </div>
        <p className="error-title">{title}</p>
        <p className="error-note">{note}</p>
        {onRetry ? (
          <>
            <Button
              variant="primary"
              onClick={() => {
                // Order matters: the owner clears its failed state first (the unmount), and
                // the retry starts second — still the same synchronous tick, so the whole
                // chain down to the delivery API runs inside this tap's activation.
                onClose();
                onRetry();
              }}
            >
              {t(lang, 'tryAgain')}
            </Button>
            <Button variant="secondary" onClick={beginClose}>
              {t(lang, 'errorDismiss')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={beginClose}>
            {t(lang, 'errorDismiss')}
          </Button>
        )}
      </div>
    </dialog>
  );
}
