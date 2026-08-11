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

// How often the display re-reads the clock. The clock shows TENTHS, so it has to be read
// at least that often or the last digit stutters — and comfortably faster than that, since
// nothing phase-locks this interval to the deadline. Cheap: the only thing subscribed at
// this rate is the timer itself (see useDeadlinePassed for why that matters).
const TICK_MS = 50;

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
//
// Over means `now > deadline` — strictly after, the ONE boundary every reader of a
// deadline shares (the store's submit check, `wordStatusOf`, `nextDeadlineRefreshAt`
// below), so no two surfaces can disagree about the deadline's own millisecond.
const passed = (deadline: number): boolean => Date.now() > deadline;

export function useDeadlinePassed(deadline: number | null): boolean {
  const [tick, bump] = useState(0);

  useEffect(() => {
    if (deadline === null || passed(deadline)) return undefined;
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

  return deadline !== null && passed(deadline);
}

// A status surface can show several persisted Word runs without mounting WordGame — the
// language chooser is the important case. `Date.now()` alone is not reactive, so find the
// first instant at which one of those statuses can change and let the same one-shot deadline
// hook force that render. A status becomes done when `now > deadline`, hence the +1ms.
// Past/null/corrupt values need no wake-up: their status is already stable at this render.
export function nextDeadlineRefreshAt(
  deadlines: readonly (number | null | undefined)[],
  now: number = Date.now(),
): number | null {
  let next: number | null = null;
  for (const deadline of deadlines) {
    if (deadline == null || !Number.isFinite(deadline) || deadline < now) continue;
    const refreshAt = deadline + 1;
    if (next === null || refreshAt < next) next = refreshAt;
  }
  return next;
}

// Force exactly one render per pending deadline (plus visibility wake-ups inherited from
// useDeadlinePassed). On that render `nextDeadlineRefreshAt` drops the newly expired one and
// selects the next, so two languages whose runs overlap transition independently.
export function useDeadlineRefresh(deadlines: readonly (number | null | undefined)[]): void {
  useDeadlinePassed(nextDeadlineRefreshAt(deadlines));
}
