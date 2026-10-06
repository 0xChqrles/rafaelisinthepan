import { useEffect, useState } from 'react';
import { activeDate } from '@whippin/shared';
import { onNavigate } from '../routing';

// THE DAY THE UNDATED ROUTE PLAYS (`/<lang>`): the active game day (shared day.ts, 22:00 ET),
// as of the last time the player ARRIVED — the page's load, a navigation (any key, back or
// forward, a tap on HOME onto the URL already shown), and the tab coming back (shown again,
// or restored from the back/forward cache, where WebKit does not reliably flip visibility).
//
// It does NOT move at the 22:00 flip itself while the tab is on screen: a sentence swapped
// under a player mid-guess is the one thing a day change must never do (versionCheck's rule
// for a reload, the same moment). Until they leave and come back the day on screen is simply
// no longer the active one — the game route says so (`isActiveDay` off the live day, the
// header's date chip and lit calendar), and HOME leads to the new day. A tab left open past
// the flip, which is how most phones keep a game, shows the new day the moment it is opened.
export default function useHomeDay(): string {
  const [day, setDay] = useState(() => activeDate(new Date()));
  useEffect(() => {
    const arrive = () => setDay(activeDate(new Date()));
    const shown = () => {
      if (document.visibilityState === 'visible') arrive();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) arrive();
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
