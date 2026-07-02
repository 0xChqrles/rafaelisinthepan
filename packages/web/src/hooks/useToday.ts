import { useEffect, useState } from 'react';
import { todayUrl, type Today } from '../api';

// The server's day id (`dayNumber`) is the same for every language and stable for the
// whole game day, so fetch it at most once per session. Module-level cache shared by
// every mount. The selector uses it to build each language's roundKey and read its
// persisted status.
let cached: number | null = null;

// Returns the current day number, or null until it resolves. Degrades to null (no
// network / no backend / an error) — the selector then simply shows "not started".
export default function useToday(): number | null {
  const [dayNumber, setDayNumber] = useState<number | null>(cached);

  useEffect(() => {
    if (cached != null) {
      setDayNumber(cached);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(todayUrl());
        if (!r.ok) return;
        const t = (await r.json()) as Today;
        cached = t.dayNumber;
        if (!cancelled) setDayNumber(t.dayNumber);
      } catch {
        // No backend configured / offline: leave dayNumber null (statuses show "new").
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return dayNumber;
}
