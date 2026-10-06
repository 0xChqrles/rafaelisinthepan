// @vitest-environment jsdom
// CONTRACT: the day the UNDATED route (`/<lang>`) plays follows the active game day (shared
// day.ts, 22:00 America/New_York) — as of the player's last ARRIVAL:
//   - a load reads the active day;
//   - the 22:00 flip does NOT swap the day under a tab that stays on screen (a sentence
//     changing under a player mid-guess);
//   - the tab COMING BACK (shown again, or restored from the back/forward cache) moves it to
//     the new day — a tab left open overnight opens on the new day;
//   - any NAVIGATION (a key, a tap on HOME onto the URL already shown) or the browser's
//     back/forward moves it too.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../routing';
import useHomeDay from './useHomeDay';

// 2026-10-06, 21:59:00 EDT (01:59 UTC on the 7th) — a minute before the flip — and just after.
const BEFORE_FLIP = new Date('2026-10-07T01:59:00.000Z');
const AFTER_FLIP = new Date('2026-10-07T02:00:30.000Z');

let shown: string | null;
function Probe() {
  shown = useHomeDay();
  return null;
}

let root: Root;
let visibility: DocumentVisibilityState;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BEFORE_FLIP);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  shown = null;
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flip = () => vi.setSystemTime(AFTER_FLIP);
const fire = async (event: Event, target: EventTarget = document) => {
  await act(async () => {
    target.dispatchEvent(event);
  });
};

describe('useHomeDay — the undated route across the 22:00 ET flip', () => {
  it('reads the active day on load', () => {
    expect(shown).toBe('2026-10-06');
  });

  it('keeps the day on a tab that stays on screen across the flip', async () => {
    flip();
    // Anything that re-renders the tab, short of an arrival, leaves the day where it was.
    await act(async () => root.render(<Probe />));
    expect(shown).toBe('2026-10-06');
  });

  it('moves to the new day when the tab comes back', async () => {
    visibility = 'hidden';
    await fire(new Event('visibilitychange'));
    flip();
    expect(shown).toBe('2026-10-06');
    visibility = 'visible';
    await fire(new Event('visibilitychange'));
    expect(shown).toBe('2026-10-07');
  });

  it('does not move while the tab is hidden: only coming back is an arrival', async () => {
    flip();
    visibility = 'hidden';
    await fire(new Event('visibilitychange'));
    expect(shown).toBe('2026-10-06');
  });

  it('moves to the new day when the page is restored from the back/forward cache', async () => {
    flip();
    const restore = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restore, 'persisted', { value: true });
    await fire(restore, window);
    expect(shown).toBe('2026-10-07');
  });

  it('moves to the new day on a navigation, even onto the URL already shown', async () => {
    flip();
    await act(async () => navigate(window.location.pathname));
    expect(shown).toBe('2026-10-07');
  });

  it('moves to the new day on the browser\'s back or forward', async () => {
    flip();
    await fire(new PopStateEvent('popstate'), window);
    expect(shown).toBe('2026-10-07');
  });
});
