import { beforeEach, describe, expect, it } from 'vitest';
import type { KeyState, KeysModel } from './keysScene';
import { isBuilt, isStamped, markBuilt, resetCalendarMemory } from './memory';
import { codesOf, markShown, nextStage, stageId, type Shown, type Stage, type Viewer } from './plan';

// The calendar's memory keeps the archive's promise that NOTHING THAT HAS LANDED MOVES: a
// month arrives once per day and account — a remount, a resize, a refetch never replays it —
// today drops once per day, and a month shown again plays only what changed since it was last
// drawn, a ceremony only for what went up — once, even left halfway. A month that arrives goes
// on arriving. Reduced motion lands at once, and is remembered so.

const viewer: Viewer = { lang: 'fr', accountId: 'acc', motion: true };
const DAY = 100;

// September 2026 on a Monday-first grid (the 1st a Tuesday): cell i holds day i, 1–30.
const cells = Array.from({ length: 42 }, (_, i) => (i >= 1 && i <= 30 ? `2026-09-${String(i).padStart(2, '0')}` : null));
function sep(state: (day: number) => KeyState, today = -1, phase: KeysModel['phase'] = 'data'): Shown {
  const keys = cells.map((date, i): KeyState => (date ? state(i) : { kind: 'pad' }));
  return { month: '2026-09', activeDay: DAY, cells, model: { keys, today, phase } };
}
const none = (day: number): KeyState => ({ kind: 'none', day });
const unknown = (day: number): KeyState => ({ kind: 'unknown', day });
// Latched, then shown: the memory marked as the raster marks it once the stage is on screen.
function show(prev: Stage | null, next: Shown, as: Viewer = viewer, arriving = false): Stage {
  const stage = nextStage(prev, next, as, arriving);
  markShown(stage, as);
  return stage;
}

beforeEach(() => resetCalendarMemory());

describe('the arrival plays once per day and account', () => {
  it('arrives on its first showing with data, and stands settled on every later one', () => {
    const first = show(null, sep(none, 4));
    expect(first.spec.build).toBe('arrive');
    expect(first.spec.drop).toBe('build');
    expect(first.give).toBe(null);
    // A remount (nothing on screen before it) of the same month, the same day: settled.
    const again = show(null, sep(none, 4));
    expect(again.spec.build).toBe(null);
    expect(again.spec.drop).toBe(null);
    expect(again.spec.changes).toEqual([]);
  });

  it('arrives under a turn at the quicker pace, and gives way from the frame on screen', () => {
    const october: Shown = { ...sep(none), month: '2026-10' };
    const shown = show(null, october);
    const turned = show(shown, sep(none));
    expect(turned.spec.build).toBe('turn');
    expect(turned.give).toBe('turn');
  });

  it('arrives where the read lands on the month on screen, key by key', () => {
    const loading = show(null, sep(unknown, -1, 'loading'));
    expect(loading.spec.digitsIn).toBe(true);
    expect(loading.spec.ghostsIn).toBe(true);
    const landed = show(loading, sep(none));
    expect(landed.spec.build).toBe('arrive');
    expect(landed.give).toBe('keys');
  });

  it('starts again for a new day, and for another account', () => {
    markBuilt(DAY, 'acc', 'fr', '2026-09');
    expect(isBuilt(DAY, 'acc', 'fr', '2026-09')).toBe(true);
    expect(isBuilt(DAY + 1, 'acc', 'fr', '2026-09')).toBe(false);
    markBuilt(DAY, 'acc', 'fr', '2026-09');
    expect(isBuilt(DAY, 'other', 'fr', '2026-09')).toBe(false);
  });

  it('lands at once under reduced motion, built and stamped as it is shown', () => {
    const still = show(null, sep(none, 4), { ...viewer, motion: false });
    expect(still.spec.build).toBe(null);
    expect(still.give).toBe(null);
    expect(isBuilt(DAY, 'acc', 'fr', '2026-09')).toBe(true);
    expect(isStamped('fr', DAY)).toBe(true);
  });
});

describe('today drops once per day', () => {
  it('drops in the arrival, and not again in the day', () => {
    show(null, sep(none, 4));
    // Even a month arriving again (another account on this device) does not drop it twice.
    const other = show(null, sep(none, 4), { ...viewer, accountId: 'other' });
    expect(other.spec.build).toBe('arrive');
    expect(other.spec.drop).toBe(null);
  });

  it('drops the new today in place at the 22:00 flip, the month standing', () => {
    const before = show(null, sep(none, 4));
    const after = show(before, { ...sep(none, 5), activeDay: DAY + 1 });
    expect(after.spec.build).toBe(null);
    expect(after.spec.drop).toBe('flip');
    expect(after.give).toBe('keys');
  });
});

describe('a month shown again plays what changed since it was drawn', () => {
  it('has no change beat on its first showing', () => {
    const first = show(null, sep((d) => (d === 10 ? { kind: 'solved', day: d } : none(d))));
    expect(first.spec.changes).toEqual([]);
  });

  it('plays a ceremony only for what went up, at most three', () => {
    show(null, sep((d) => (d === 7 || d === 5 ? { kind: 'progress', day: d, pct: 60 } : none(d))));
    // Back from playing: 2, 3, 4 and 10 solved, 7 down to 20% (a republished day restarted),
    // and 1 (never opened) and 5 (at 60%) OVER — given up.
    const solved = new Set([2, 3, 4, 10]);
    const over = new Set([1, 5]);
    const back = show(
      null,
      sep((d) =>
        solved.has(d)
          ? { kind: 'solved', day: d }
          : over.has(d)
            ? { kind: 'over', day: d }
            : d === 7
              ? { kind: 'progress', day: d, pct: 20 }
              : none(d),
      ),
    );
    expect(back.spec.build).toBe(null);
    expect(back.spec.changes.map((c) => [c.index, c.from])).toEqual([
      [1, 'n'],
      [2, 'n'],
      [3, 'n'],
      [4, 'n'],
      [5, 'p60'],
      [7, 'p60'],
      [10, 'n'],
    ]);
    // The first three ups charge; the fourth up, the downgrade and the days turned over
    // dissolve — an over day is no up, so it takes no ceremony's slot, even ahead of the ups.
    const charged = back.beats.charge.flatMap((at, i) => (at > -Infinity ? [i] : []));
    const dissolved = back.beats.dissolve.flatMap((at, i) => (at > -Infinity ? [i] : []));
    expect(charged).toEqual([2, 3, 4]);
    expect(dissolved).toEqual([1, 5, 7, 10]);
  });

  it('keeps an over day apart from every other reading', () => {
    const over = sep((d) => (d === 12 ? { kind: 'over', day: d } : none(d)));
    expect(codesOf(over.model, over.cells).get('2026-09-12')).toBe('o');
    // Its stage is its own: never mistaken for the % it reached, a day out of range, or none.
    const others: KeyState[] = [{ kind: 'progress', day: 12, pct: 40 }, { kind: 'out', day: 12 }, none(12)];
    for (const other of others) {
      const shown = sep((d) => (d === 12 ? other : none(d)));
      expect(stageId(shown, viewer)).not.toBe(stageId(over, viewer));
    }
  });

  it('compares a fresh answer for the month on screen with the frame on screen', () => {
    const shown = show(null, sep(none));
    const answer = show(shown, sep((d) => (d === 12 ? { kind: 'solved', day: d } : none(d))));
    expect(answer.give).toBe('keys');
    expect(answer.spec.changes).toEqual([{ index: 12, from: 'n' }]);
  });
});

describe('a ceremony plays once', () => {
  it('plays a change once, even left halfway', () => {
    const arrival = show(null, sep(none));
    // A fresh answer, Sep 10 solved: its change is shown — and never settles (the player leaves).
    const solved = sep((d) => (d === 10 ? { kind: 'solved', day: d } : none(d)));
    const answer = show(arrival, solved);
    expect(answer.spec.changes).toEqual([{ index: 10, from: 'n' }]);
    // Back on the archive (a remount, nothing on screen before it): nothing left to play.
    const back = show(null, solved);
    expect(back.spec.changes).toEqual([]);
  });
});

describe('a month that arrives goes on arriving', () => {
  const changed = sep((d) => (d === 10 ? { kind: 'solved', day: d } : none(d)), 4);

  it('joins the arrival with a fresh answer landing while it plays', () => {
    const arrival = show(null, sep(none, 4));
    const joined = show(arrival, changed, viewer, true);
    expect(joined.spec.build).toBe(arrival.spec.build);
    expect(joined.spec.drop).toBe(arrival.spec.drop);
    expect(joined.spec.changes).toEqual([]);
    expect(joined.carries).toBe(true);
  });

  it('plays the change of a fresh answer landing once the arrival has settled', () => {
    const arrival = show(null, sep(none, 4));
    const after = show(arrival, changed, viewer, false);
    expect(after.spec.build).toBe(null);
    expect(after.spec.changes).toEqual([{ index: 10, from: 'n' }]);
    expect(after.carries).toBe(false);
  });
});
