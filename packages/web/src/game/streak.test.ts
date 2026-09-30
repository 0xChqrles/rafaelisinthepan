// CONTRACT: what the SCREEN derives from the per-language SET of solved game days
// (packages/web/src/game/streak.ts, issues #56/#74) — never persisted counters:
//   - streakTransition = the before/after streak a solve celebrates, anchored to the
//     solved day;
//   - weekView = the Monday-first week containing the active day, as 7 cells.
// The streak itself (`currentStreak`) is @whippin/shared's since #204 and is
// contract-tested there.

import { describe, it, expect } from 'vitest';
import { streakTransition, weekView } from './streak';

// 2024-01-01 is a MONDAY; its dayNumber is a clean anchor for the Monday-based week math.
const MON = Math.floor(Date.UTC(2024, 0, 1) / 86_400_000);
const TUE = MON + 1;
const WED = MON + 2;
const SUN = MON + 6;

describe('streakTransition', () => {
  it('increments a live consecutive streak', () => {
    expect(streakTransition([8, 9, 10], 10)).toEqual({ previous: 2, next: 3 });
  });

  it('starts at 0 -> 1 when there was no live streak', () => {
    expect(streakTransition([5, 10], 10)).toEqual({ previous: 0, next: 1 });
  });

  it('starts at 0 -> 1 on the first-ever solve', () => {
    expect(streakTransition([10], 10)).toEqual({ previous: 0, next: 1 });
  });
});

describe('weekView — the Monday-based weekly row (#74)', () => {
  it('returns 7 cells, Monday-first, for the week containing the active day', () => {
    const { cells } = weekView([WED], WED);
    expect(cells).toHaveLength(7);
    expect(cells[0].dayNumber).toBe(MON); // Monday first
    expect(cells[6].dayNumber).toBe(SUN); // Sunday last
  });

  it('anchors the same week from ANY day in it (Monday, mid-week, and Sunday)', () => {
    // A Sunday active day still belongs to the Monday-starting week (not the next one).
    expect(weekView([MON], MON).cells[0].dayNumber).toBe(MON);
    expect(weekView([WED], WED).cells[0].dayNumber).toBe(MON);
    expect(weekView([SUN], SUN).cells[0].dayNumber).toBe(MON);
  });

  it('flags solved / today / future correctly on a partial week', () => {
    // First solve Monday, played through Wednesday (today); Thu..Sun still to come.
    const { cells } = weekView([MON, TUE, WED], WED);
    expect(cells.map((c) => c.solved)).toEqual([true, true, true, false, false, false, false]);
    expect(cells.map((c) => c.isFuture)).toEqual([false, false, false, true, true, true, true]);
    expect(cells.find((c) => c.isToday)?.dayNumber).toBe(WED);
  });

  it('a full solved week is all solved, none future', () => {
    const days = [MON, TUE, WED, MON + 3, MON + 4, MON + 5, SUN];
    const { cells } = weekView(days, SUN);
    expect(cells.every((c) => c.solved)).toBe(true);
    expect(cells.some((c) => c.isFuture)).toBe(false);
  });

  it('leaves an elapsed unsolved day empty rather than future', () => {
    // First-ever solve is Wednesday: Mon/Tue are elapsed and unsolved.
    const { cells } = weekView([WED], WED);
    expect(cells.slice(0, 2).every((c) => !c.solved && !c.isFuture)).toBe(true);
  });
});
