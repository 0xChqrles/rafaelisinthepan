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
// second line of defense for browsers that heavily throttle background-tab timers.
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

    refresh();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  return today;
}
