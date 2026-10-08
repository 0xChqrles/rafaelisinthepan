import { useEffect, useState } from 'react';
import { activeDate } from '@whippin/shared';
import { onNavigate } from '../routing';

// THE DAY ACROSS THE 22:00 ET FLIP (shared day.ts). Three rules, one per export:
//   - the UNDATED route plays the active day as of the player's last ARRIVAL (`useHomeDay`);
//   - the tab coming back to a ROUND IN PROGRESS is no arrival (`useHoldHomeDay`);
//   - a round ON SCREEN keeps the day it was opened as (`useOpenedAsActive`).
// Together: the flip never changes anything under a player looking at the screen — not the
// sentence, not its racing, not its boards — and the new day takes over the moment they ask
// for it (a navigation) or come back to a tab with nothing in progress.

// The rounds in progress on screen: a guess played, the round not over. While one stands,
// the tab coming back is not an arrival — a player who looked away mid-round finds their
// sentence where they left it, and takes the new day by asking for it (HOME, any key).
let holds = 0;

// THE DAY THE UNDATED ROUTE PLAYS (`/<lang>`): the active game day as of the last time the
// player ARRIVED —
//   - the page's load;
//   - a navigation (any key, back or forward, a tap on HOME onto the URL already shown);
//   - the tab coming back (shown again, or restored from the back/forward cache, where WebKit
//     does not reliably flip visibility) — unless it comes back to a round in progress.
//
// It does NOT move at the flip itself while the tab is on screen: a sentence swapped under a
// player mid-guess is the one thing a day change must never do (versionCheck's rule for a
// reload, the same moment). Until they arrive again the day on screen is simply no longer
// the active one — the header says so (the day's date, the calendar lit) and HOME leads to
// the new day. A tab left open past the flip, which is how most phones keep a game, shows
// the new day the moment it is opened, a round left half-played excepted.
export default function useHomeDay(): string {
  const [day, setDay] = useState(() => activeDate(new Date()));
  useEffect(() => {
    const arrive = () => setDay(activeDate(new Date()));
    const back = () => {
      if (holds === 0) arrive();
    };
    const shown = () => {
      if (document.visibilityState === 'visible') back();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) back();
    };
    const off = onNavigate(arrive);
    window.addEventListener('popstate', arrive);
    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange', shown);
    return () => {
      off();
      window.removeEventListener('popstate', arrive);
      window.removeEventListener('pageshow', restored);
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);
  return day;
}

// A round IN PROGRESS holds the day the undated route plays against the tab coming back
// (above). `hold` is the round's own reading — a guess played and the round not over — so a
// round that ends releases it, and the next time the tab comes back the new day takes over.
export function useHoldHomeDay(hold: boolean): void {
  useEffect(() => {
    if (!hold) return undefined;
    holds += 1;
    return () => {
      holds -= 1;
    };
  }, [hold]);
}

// THE ROUND KEEPS THE DAY IT WAS OPENED AS. Whether `round` (one puzzle in one language) is
// the active day, read when it comes on screen and kept for as long as it stays there: the
// flip passing a round on screen does not turn it into an archive day under the player — its
// race line, its result's boards and its race band stay — and a tap on them still opens the
// board, which is always the ACTIVE day's: past the flip, the new day's. A NEW round (another
// puzzle, another language) reads it afresh. `day` is the round's date, null for a bonus.
//
// It is read off the SAME clock the undated route's day is (`useHomeDay`): the wall clock at
// that moment, never a timer's last tick. An arrival past the flip opens the new day's round
// in the render that moves the day, and a timer-driven reading (`useToday`, whose timer a
// sleeping laptop or a page restored from the back/forward cache resumes late) can still say
// the old day there — a round latched off it would stay an archive day for its whole life.
//
// ONE EXCEPTION, which only ever turns it ON: a round opened AHEAD of its date (a DAY PREVIEW
// link, root AGENTS.md) becomes the active day when its day arrives while it is on screen —
// re-read on each render until then — so the operator who solved it early and left the tab
// open finds its race and boards on the day, and a preview solved just past the flip is
// celebrated like the on-time solve the server credited. A round already active never loses it.
export function useOpenedAsActive(round: string, day: string | null): boolean {
  const [opened, setOpened] = useState(() => openedAs(round, day));
  if (opened.round !== round) {
    const next = openedAs(round, day);
    setOpened(next);
    return next.active;
  }
  if (opened.ahead && activeNow(day)) {
    setOpened({ round, active: true, ahead: false });
    return true;
  }
  return opened.active;
}

function openedAs(round: string, day: string | null) {
  const today = activeDate(new Date());
  return { round, active: day !== null && day === today, ahead: day !== null && day > today };
}

function activeNow(day: string | null): boolean {
  return day !== null && day === activeDate(new Date());
}
