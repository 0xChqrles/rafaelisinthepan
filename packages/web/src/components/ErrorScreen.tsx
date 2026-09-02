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
// ONE quiet way out.
//
// **THERE IS NO TRY AGAIN (user-decided 2026-09-03, retiring the primary it carried since
// 2026-08-24).** A full-screen error page is not a place to retry FROM: the act that failed
// belongs to the screen underneath, and the honest gesture is to go back to it and press the
// same button again — where the state it needs (the typed address, the drawing, the gate) is
// still on screen. What the retry bought was one tap; what it cost was a lit primary on a
// page whose only real message is "that did not work", and a second button competing with
// the way out. So the surface is the bot, the title, the note, and a single SECONDARY that
// dismisses — the note says what to do, and the screen under it is where to do it.
//
// Follows the modal rules (`useModalDismiss`) for DISMISSAL: opening focuses the dialog, a
// backdrop tap is not one (there is no backdrop left to tap), and Escape leaves through the
// `error-out` exit beat. The retired retry needed a synchronous, in-tap firing (WebKit refuses
// a clipboard write reached across an async boundary — PR-219 review); with the retry gone
// that constraint is gone with it, and the act is re-run from the screen that owns it, inside
// its own fresh tap.
export default function ErrorScreen({
  lang,
  title,
  note,
  onClose,
}: {
  lang: string;
  // WHAT failed, in the chrome voice (all-caps, localized upstream).
  title: string;
  // What happened and what to do about it — a sentence, not a code.
  note: string;
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
        <Button variant="secondary" onClick={beginClose}>
          {t(lang, 'errorDismiss')}
        </Button>
      </div>
    </dialog>
  );
}
