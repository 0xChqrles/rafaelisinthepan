// @vitest-environment jsdom
// CONTRACT: the day across the 22:00 ET flip (shared day.ts, 22:00 America/New_York).
//
// The day the UNDATED route (`/<lang>`) plays (`useHomeDay`) is the active game day as of the
// player's last ARRIVAL:
//   - a load reads the active day;
//   - the 22:00 flip does NOT swap the day under a tab that stays on screen (a sentence
//     changing under a player mid-guess);
//   - the tab COMING BACK (shown again, or restored from the back/forward cache) moves it to
//     the new day — a tab left open overnight opens on the new day — UNLESS it comes back to
//     a ROUND IN PROGRESS (`useHoldHomeDay`: a guess played, the round not over), which keeps
//     its day until the player asks for the new one;
//   - any NAVIGATION (a key, a tap on HOME onto the URL already shown) or the browser's
//     back/forward moves it, round in progress or not.
//
// A round ON SCREEN keeps the day it was opened as (`useOpenedAsActive`): the flip passing it
// does not turn it into an archive day; a new round reads it afresh, off the SAME clock the
// arrival read — so the round an arrival opens on the new day is the active day.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigate } from '../routing';
import useHomeDay, { useHoldHomeDay, useOpenedAsActive } from './useHomeDay';

// 2026-10-06, 21:59:00 EDT (01:59 UTC on the 7th) — a minute before the flip — and just after.
const BEFORE_FLIP = new Date('2026-10-07T01:59:00.000Z');
const AFTER_FLIP = new Date('2026-10-07T02:00:30.000Z');

let shown: string | null;
let opened: boolean | null;
// GameRoute's own wiring: the round is a bonus, the route's date, or the undated route's day.
function Probe({
  hold = false,
  lang = 'fr',
  date,
  bonus,
}: {
  hold?: boolean;
  lang?: string;
  date?: string;
  bonus?: string;
}) {
  shown = useHomeDay();
  useHoldHomeDay(hold);
  const day = date ?? shown;
  opened = useOpenedAsActive(`${lang}:${bonus ?? day}`, bonus === undefined ? day : null);
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
  opened = null;
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flip = () => vi.setSystemTime(AFTER_FLIP);
const render = async (props: Parameters<typeof Probe>[0]) => {
  await act(async () => root.render(<Probe {...props} />));
};
const fire = async (event: Event, target: EventTarget = document) => {
  await act(async () => {
    target.dispatchEvent(event);
  });
};
const hideAndShow = async () => {
  visibility = 'hidden';
  await fire(new Event('visibilitychange'));
  visibility = 'visible';
  await fire(new Event('visibilitychange'));
};
const restore = async () => {
  const event = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(event, 'persisted', { value: true });
  await fire(event, window);
};

describe('useHomeDay — the undated route across the 22:00 ET flip', () => {
  it('reads the active day on load', () => {
    expect(shown).toBe('2026-10-06');
  });

  it('keeps the day on a tab that stays on screen across the flip', async () => {
    flip();
    // Anything that re-renders the tab, short of an arrival, leaves the day where it was.
    await render({});
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
    await restore();
    expect(shown).toBe('2026-10-07');
  });

  it('moves to the new day on a navigation, even onto the URL already shown', async () => {
    flip();
    await act(async () => navigate(window.location.pathname));
    expect(shown).toBe('2026-10-07');
  });

  it("moves to the new day on the browser's back or forward", async () => {
    flip();
    await fire(new PopStateEvent('popstate'), window);
    expect(shown).toBe('2026-10-07');
  });
});

describe('useHoldHomeDay — coming back to a round in progress', () => {
  it('keeps the day when the tab comes back, shown again or restored', async () => {
    await render({ hold: true });
    flip();
    await hideAndShow();
    expect(shown).toBe('2026-10-06');
    await restore();
    expect(shown).toBe('2026-10-06');
  });

  it('gives way to a navigation: the player asked for the new day', async () => {
    await render({ hold: true });
    flip();
    await act(async () => navigate(window.location.pathname));
    expect(shown).toBe('2026-10-07');
  });

  it('gives way to the browser’s back or forward', async () => {
    await render({ hold: true });
    flip();
    await fire(new PopStateEvent('popstate'), window);
    expect(shown).toBe('2026-10-07');
  });

  it('lets the new day in on the next return once the round has ended', async () => {
    await render({ hold: true });
    flip();
    await hideAndShow();
    expect(shown).toBe('2026-10-06');
    // The round ends on screen: nothing moves under the player…
    await render({ hold: false });
    expect(shown).toBe('2026-10-06');
    // …and the next time they come back, the new day takes over.
    await hideAndShow();
    expect(shown).toBe('2026-10-07');
  });

  it('lets go when the round leaves the screen', async () => {
    await render({ hold: true });
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render({});
    flip();
    await hideAndShow();
    expect(shown).toBe('2026-10-07');
  });
});

describe('useOpenedAsActive — a round keeps the day it was opened as', () => {
  it('stays the active day when the flip passes it on screen', async () => {
    expect(opened).toBe(true);
    flip();
    await render({});
    expect(opened).toBe(true);
  });

  it('reads a NEW round afresh: another day, or another language', async () => {
    await render({ date: '2026-10-05' });
    expect(opened).toBe(false);
    await render({ lang: 'en', date: '2026-10-05' });
    expect(opened).toBe(false);
    await render({});
    expect(opened).toBe(true);
    // Past the flip, a round opened on the day the screen still shows is an archive day.
    flip();
    await render({ lang: 'en' });
    expect(opened).toBe(false);
  });

  it('opens the round an arrival brings past the flip as the active day', async () => {
    // The undated route's day moves on the arrival, and its round is read off that same
    // clock — never off a reading that has not caught up with it yet.
    flip();
    await restore();
    expect(shown).toBe('2026-10-07');
    expect(opened).toBe(true);
  });

  it('opens the round a navigation brings past the flip as the active day', async () => {
    flip();
    await act(async () => navigate(window.location.pathname));
    expect(shown).toBe('2026-10-07');
    expect(opened).toBe(true);
  });

  it('a round opened AHEAD of its date (a preview link) becomes active when its day arrives', async () => {
    // Opened on the 6th for the 7th: not today yet.
    await render({ date: '2026-10-07' });
    expect(opened).toBe(false);
    // Still on screen past the flip: its day is the active one now — race and boards on.
    flip();
    await render({ date: '2026-10-07' });
    expect(opened).toBe(true);
  });

  it('a round opened ahead and still ahead stays off; an archive day never turns on', async () => {
    await render({ date: '2026-10-09' });
    flip();
    await render({ date: '2026-10-09' });
    expect(opened).toBe(false);
  });

  it('never makes a bonus the active day', async () => {
    await render({ bonus: 'bonus/1234567' });
    expect(opened).toBe(false);
  });
});
