import { useEffect, useState } from 'react';

// Word mode's clock (#163). The run's end is a wall-clock DEADLINE, not a counter this
// hook decrements: it reads `Date.now()` against a fixed instant and reports what is
// left. Everything the no-pause rule promises falls out of that shape rather than being
// defended anywhere —
//
//   - backgrounding the tab throttles this interval to nothing and the clock is still
//     right on the next read, because nothing here was counting;
//   - a reload rehydrates the same deadline and resumes with the real remaining time;
//   - there is no remaining-seconds value to freeze, so closing the tab mid-bad-run
//     cannot bank it.
//
// The remaining time is therefore DERIVED AT RENDER, and the interval below exists only
// to force those renders. Storing it instead would be one frame stale at exactly the
// worst moment: the deadline appears in the same commit that starts the run, so a value
// only an effect could refresh would paint one frame reading zero — which is the run's
// own end condition, and the whole ending would fire on the START tap. Reading the clock
// during render is not idempotent, which is the trade: for a number whose entire job is
// to differ from its last value, that is the correct shape.
//
// `deadline` is null before START; the run then simply has no time to report.

// How often the display re-reads the clock. Fast enough that the seconds figure turns on
// time (a whole-second cadence would show each number for anywhere between 0 and 2
// seconds depending on the phase it started in), slow enough to be free.
const TICK_MS = 100;

const leftOf = (deadline: number): number => Math.max(0, deadline - Date.now());

export default function useCountdown(deadline: number | null): number {
  const [, bump] = useState(0);

  useEffect(() => {
    // Nothing to watch: no run yet, or one whose time is already spent (a rehydrated
    // finished round schedules no timer at all).
    if (deadline === null || leftOf(deadline) === 0) return undefined;
    let timer = 0;
    const read = () => {
      bump((n) => n + 1);
      if (leftOf(deadline) === 0) window.clearInterval(timer);
    };
    timer = window.setInterval(read, TICK_MS);
    // Coming back to a throttled or suspended tab: read once immediately instead of
    // waiting out the next tick to notice the run is over.
    document.addEventListener('visibilitychange', read);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [deadline]);

  return deadline === null ? 0 : leftOf(deadline);
}

// The same deadline, asked the ONE question the game itself has of it: is the run over?
//
// It exists because the two questions have very different render costs. The HUD wants a
// number ten times a second and pays for it alone, inside the timer; the SCREEN wants a
// single transition, and subscribing it to the fine clock would re-render the prompt and
// the keyboard at 10 Hz through the whole run — during exactly the phase where a fast
// game must not make the player wait on a keystroke. So this schedules ONE timeout, for
// the deadline itself, and re-renders once.
//
// `tick` is in the effect's deps so a wake-up that did NOT cross the deadline re-arms:
// a timer can be clamped or throttled to fire early-ish relative to the wall clock, and
// the derived value must never be left un-rechecked because of it.
export function useDeadlinePassed(deadline: number | null): boolean {
  const [tick, bump] = useState(0);

  useEffect(() => {
    if (deadline === null || leftOf(deadline) === 0) return undefined;
    const wake = () => bump((n) => n + 1);
    // A few ms past the deadline, so the re-render lands on the far side of it rather
    // than one clamp short and needing a second pass.
    const timer = window.setTimeout(wake, leftOf(deadline) + 20);
    // A background tab suspends timers entirely; the run is still over when it returns.
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [deadline, tick]);

  return deadline !== null && leftOf(deadline) === 0;
}
