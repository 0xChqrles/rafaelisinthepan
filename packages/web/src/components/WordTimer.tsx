import useCountdown from '../hooks/useCountdown';
import { START_SECONDS } from '../game/wordGame';
import { srWordClock, srWordClockIdle, t } from '../i18n';

// Word mode's clock, as the HUD (#163). It is the resource the whole game is played
// against, so it takes the header's status corner — where the sentence game shows its
// progress counter — at a size the corner can carry, and it is where the run's ONE
// reward lands: the seconds a claim just bought.
//
// That split is the mode's feedback grammar, and it is deliberate: a float ON THE WORD
// is about the guess (its rank, or MISS), a gain ON THE TIMER is about your clock. The
// score is neither — it is the WATERMARK behind the play surface, because it is the
// thing displayed properly later, as the end screen's headline.

// Where the clock stops being a number and starts being a warning — the last 20 seconds.
// Presentation only: the run's length is `game/wordGame.ts`'s to declare, this is just
// when the HUD raises its voice about it.
const WARN_SECONDS = 20;

// A gain to play, handed down by the screen. `id` is monotonic so two claims in a row
// restart the animation instead of the second one landing on a finished element.
export interface TimeGain {
  id: number;
  seconds: number;
}

export default function WordTimer({
  lang,
  deadline,
  gain = null,
}: {
  lang: string;
  // The run's end instant, or null before START — when the clock previews a full run's
  // length instead, so the number teaches what it is before it starts moving.
  deadline: number | null;
  gain?: TimeGain | null;
}) {
  // The clock is subscribed to HERE rather than by the screen, on purpose: this is the
  // only thing on the page that needs a new value ten times a second, so it is the only
  // thing that re-renders that often (see hooks/useCountdown's useDeadlinePassed).
  const remainingMs = useCountdown(deadline);
  const idle = deadline === null;
  // Counted in DECISECONDS, because that is what the clock shows. CEIL, so the last tenth
  // is a whole tenth on screen and the display only reads 0.0 when the run is genuinely
  // over — floor would show 0.0 for the final tenth of play.
  const tenths = idle ? START_SECONDS * 10 : Math.ceil(remainingMs / 100);
  const whole = Math.floor(tenths / 10);
  // Spent is its own state, not the deepest warning: a run that is over has nothing left
  // to warn about, and a red 0.0 beating away under the whole result screen would.
  const spent = !idle && tenths === 0;
  const warn = !idle && !spent && tenths <= WARN_SECONDS * 10;
  return (
    <span
      className={`word-timer${warn ? ' warn' : ''}${spent ? ' spent' : ''}${idle ? ' idle' : ''}`}
      // A live region that must be OFF: the clock has to be readable on demand and never
      // announced every second — let alone every tenth of one, which is why the label
      // rounds to whole seconds where the display does not. `timer`'s implicit live value
      // IS off, but it subclasses `status` (implicit polite) and AT that fall back to the
      // superclass would speak every change for the whole run — one attribute removes the
      // ambiguity. Idle, the label says what the number is: a preview of the run's
      // length, not seconds already draining.
      role="timer"
      aria-live="off"
      aria-label={
        idle ? srWordClockIdle(lang, START_SECONDS) : srWordClock(lang, Math.ceil(tenths / 10))
      }
    >
      {spent ? (
        // At zero the clock STATES the run's end instead of sitting on a dead `0.0` (#175):
        // the number has nothing left to say and the words do. It is the one visible
        // statement of the end during the hold before the board — and it is what tells a
        // guess that died on the buzzer apart from a dropped keystroke: the store refuses
        // that guess silently (correctly — no grade, no `+s`), and this landing in the
        // same beat is its whole explanation. Pops in like a gain rather than swapping,
        // so it reads as an event. The label is still the clock's (sr: "0 seconds left")
        // — the run's end is announced once by the screen, not by this live-off region.
        <span className="timer-up" aria-hidden="true">
          {t(lang, 'wordTimeUp')}
        </span>
      ) : (
        <>
          <span aria-hidden="true">{whole}</span>
          {/* The tenth rides SMALLER than the seconds, and that is width and not taste:
              the header corner holds about 104px at 320px before it reaches the icon
              group, and a three-digit clock plus a full-size `.0` does not fit in it.
              Smaller also reads right — the seconds are the number, the tenth is the
              number moving. */}
          <span className="timer-dec" aria-hidden="true">
            {`.${tenths % 10}`}
          </span>
        </>
      )}
      {gain && (
        <span key={gain.id} className="timer-gain" aria-hidden="true">
          {`+${gain.seconds}s`}
        </span>
      )}
    </span>
  );
}
