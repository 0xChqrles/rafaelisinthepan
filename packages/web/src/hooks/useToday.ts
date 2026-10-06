import { useEffect, useState } from 'react';
import { activeDate, dayNumber, nextResetAt } from '@whippin/shared';

// Land just beyond the exact wall-clock boundary so clock precision cannot reschedule the
// same reset. nextResetAt itself remains the one DST-correct source of the reset instant.
const RESET_EPSILON_MS = 1;

export function todayDayNumberAt(instant: Date): number {
  return dayNumber(activeDate(instant));
}

export function millisecondsUntilTodayRefresh(instant: Date): number {
  return Math.max(
    RESET_EPSILON_MS,
    nextResetAt(instant).getTime() - instant.getTime() + RESET_EPSILON_MS,
  );
}

// The current game day's id, computed locally from the shared 22:00-ET rule. Unlike a
// render-only clock read, this hook invalidates itself at the next DST-correct reset, so a
// long-lived header cannot display an expired streak indefinitely. Visibility refresh is a
// second line of defense for browsers that heavily throttle background-tab timers, and a
// page restored from the back/forward cache refreshes too: its timer resumes with the time it
// had left, and WebKit does not reliably flip visibility for the restore (`useHomeDay` moves
// the undated route's day on that same event, so the header's reading keeps up with it).
export default function useToday(): number {
  const [today, setToday] = useState(() => todayDayNumberAt(new Date()));

  useEffect(() => {
    let timer: number | undefined;

    const refresh = () => {
      const now = new Date();
      setToday(todayDayNumberAt(now));
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, millisecondsUntilTodayRefresh(now));
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const refreshWhenRestored = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };

    refresh();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('pageshow', refreshWhenRestored);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('pageshow', refreshWhenRestored);
    };
  }, []);

  return today;
}
