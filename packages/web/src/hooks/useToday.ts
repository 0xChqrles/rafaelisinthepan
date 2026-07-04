import { useEffect, useState } from 'react';
import { todayUrl, type Today } from '../api';

// The server's day id (`dayNumber`) is the same for every language and stable for the
// whole game day, so cache it at module level — but only UNTIL the 22:00-ET flip
// (`secondsUntilNextReset`, sent by /today): a session-long cache would keep badging
// yesterday's rounds as today's in a tab left open across the reset. The selector uses
// it to build each language's roundKey and read its persisted status.
let cached: { dayNumber: number; expiresAt: number } | null = null;

function freshDayNumber(): number | null {
  return cached && Date.now() < cached.expiresAt ? cached.dayNumber : null;
}

// Returns the current day number, or null until it resolves. Degrades to null (no
// network / no backend / an error) — the selector then simply shows "not started".
export default function useToday(): number | null {
  const [dayNumber, setDayNumber] = useState<number | null>(freshDayNumber);

  useEffect(() => {
    const fresh = freshDayNumber();
    if (fresh != null) {
      setDayNumber(fresh);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(todayUrl());
        if (!r.ok) return;
        const t = (await r.json()) as Today;
        // Expire at the server's next flip; a backend that omits the field (older
        // deploy) degrades to a short TTL rather than a stale session-long cache.
        cached = {
          dayNumber: t.dayNumber,
          expiresAt: Date.now() + (t.secondsUntilNextReset ?? 60) * 1000,
        };
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
