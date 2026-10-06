import useModalDismiss from '../hooks/useModalDismiss';
import ScreenFrame from './ScreenFrame';
import { t } from '../i18n';
import botIdle from '../assets/error-bot-idle.png';

// The app's ONE error surface for an ACT that did not land (#216 trigger rework, user-decided
// 2026-08-24): the account-deploying buttons (the PLAY gate, the invite accept, the profile
// save), a group act (create, leave, remove, invite), the give-up, and the email flow's SEND.
// A LOAD that failed keeps `LoadError`: that is a screen that could not open, where this is an
// act that did not land. A VERDICT ON WHAT THE PLAYER TYPED is never here — a refused name, a
// refused drawing, a code that expired: those answer at the field, where the player's next
// act happens (the email code step, the profile editor, the naming screen).
//
// **IT IS A FULL-SCREEN MODAL, NOT A SHEET (user-decided 2026-08-27).** A sheet is the
// dismissal gesture's own shape — it slides up from the edge and asks to be swiped away —
// while every message here is about an act the player meant. So it takes the whole screen.
//
// **IT WEARS THE FULL-SCREEN MOMENT'S FRAME** (the signed-out screen's and the streak
// celebration's: the four corner brackets and the WHIPPIN AI lockup, `ScreenFrame`), so it
// reads as the app's own screen rather than an error page; it comes in through the board's
// Bayer dissolve over the screen it answers, and leaves the same way (`board-dissolve-out`).
//
// **THE MESSENGER IS THE ERROR BOT (user-drawn, 2026-08-27), and it SPEAKS the error.** A
// character delivering bad news is the game's own voice. `error-bot-idle.png` is a 4-frame
// 32x32 idle bob, and `error-speech-ballon.png` the balloon it speaks through — ERROR ! is
// part of the drawing, one word in every language like MISS and STREAK.
//
// The stack: the bot saying ERROR ! · WHAT was lost (chrome voice, all-caps, the danger ink:
// "GROUP NOT CREATED", never a bare "FAILED") · what to do about it (a sentence) · and, on the
// bottom edge where the signed-out screen parks its calls, ONE quiet way out.
//
// **THERE IS NO TRY AGAIN (user-decided 2026-09-03).** The act that failed belongs to the
// screen underneath, where the state it needs (the typed address, the drawing, the gate) is
// still on screen; the honest gesture is to go back to it and press the same button again.
// So the way out is GO BACK, the bracketed quiet word — nothing on the page is lit.
//
// Follows the modal rules (`useModalDismiss`): opening focuses the dialog, there is no
// backdrop to tap, and Escape leaves through the same exit.
export default function ErrorScreen({
  lang,
  title,
  note,
  onClose,
}: {
  lang: string;
  // WHAT was lost, in the chrome voice (all-caps, localized upstream).
  title: string;
  // What to do about it — a sentence, not a code.
  note: string;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('board-dissolve-out');

  return (
    <dialog
      {...dialogProps}
      className={`error-screen${closing ? ' closing' : ''}`}
      aria-label={title}
      onClose={onClose}
    >
      <ScreenFrame />
      <div className="error-body">
        {/* Decorative: the balloon says ERROR, the TITLE below says what was lost, and a
            reader hearing both would hear the bad news twice. */}
        <div className="error-bot" aria-hidden>
          <div className="error-balloon" />
          <div className="error-bot-sprite" style={{ backgroundImage: `url(${botIdle})` }} />
        </div>
        <p className="error-title">{title}</p>
        <p className="error-note">{note}</p>
      </div>
      <div className="error-calls">
        <button type="button" className="quiet-btn" onClick={beginClose}>
          {t(lang, 'errorDismiss')}
        </button>
      </div>
    </dialog>
  );
}
