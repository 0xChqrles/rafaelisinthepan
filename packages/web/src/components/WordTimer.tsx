import useCountdown from '../hooks/useCountdown';
import { START_SECONDS } from '../game/wordGame';
import { srWordClock } from '../i18n';

// Word mode's clock, as the HUD (#163). It is the resource the whole game is played
// against, so it takes the header's status corner — where the sentence game shows its
// progress counter — at a size the corner can carry, and it is where the run's ONE
// reward lands: the seconds a claim just bought.
//
// That split is the mode's feedback grammar, and it is deliberate: a float ON THE WORD
// is about the guess (its rank, or MISS), a gain ON THE TIMER is about your clock. The
// score is neither — it is the WATERMARK behind the play surface, because it is the
// thing displayed properly later, as the end screen's headline.

// Where the clock stops being a number and starts being a warning. Presentation only —
// the run's length is `game/wordGame.ts`'s to declare, this is just when the HUD raises
// its voice about it.
const WARN_SECONDS = 10;

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
  // CEIL, so the last second is a whole second on screen and the display only reads 0
  // when the run is genuinely over — floor would show 0 for the final second of play.
  const seconds = idle ? START_SECONDS : Math.ceil(remainingMs / 1000);
  // Spent is its own state, not the deepest warning: a run that is over has nothing left
  // to warn about, and a red 0 beating away under the whole result screen would.
  const spent = !idle && seconds === 0;
  const warn = !idle && !spent && seconds <= WARN_SECONDS;
  return (
    <span
      className={`word-timer${warn ? ' warn' : ''}${spent ? ' spent' : ''}${idle ? ' idle' : ''}`}
      // A live region that defaults to OFF, which is exactly right: the clock must be
      // readable on demand and must never be announced every second.
      role="timer"
      aria-label={srWordClock(lang, seconds)}
    >
      <span aria-hidden="true">{seconds}</span>
      {gain && (
        <span key={gain.id} className="timer-gain" aria-hidden="true">
          {`+${gain.seconds}s`}
        </span>
      )}
    </span>
  );
}
