// CONTRACT: what the SCREEN derives from the per-language SET of solved game days
// (packages/web/src/game/streak.ts, issues #56/#74) — never persisted counters:
//   - streakTransition = the before/after streak a solve celebrates, anchored to the
//     solved day;
//   - weekView = the Monday-first week containing the active day, as 7 cells;
//   - recordWeek = the account record's chain: the week of the language holding the account's
//     streak (the MAXIMUM of the per-language live streaks, #204), never a union of languages.
// The streak itself (`currentStreak`) is @whippin/shared's since #204 and is
// contract-tested there.

import { describe, it, expect } from 'vitest';
import { mondayNarrowLabels, recordWeek, streakTransition, weekView } from './streak';

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

  it('a day credited AHEAD of its date (a preview solve) is future, not solved', () => {
    const { cells } = weekView([MON, TUE, MON + 4], TUE);
    expect(cells[4]).toMatchObject({ dayNumber: MON + 4, solved: false, isFuture: true });
    expect(cells.map((c) => c.solved)).toEqual([true, true, false, false, false, false, false]);
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

describe("recordWeek — the chain under the account's streak", () => {
  const solved = (cells: ReturnType<typeof recordWeek>) => cells.map((c) => c.solved);

  it('is the week of the language holding the longest live streak', () => {
    // fr: Mon + Wed (live streak 1 on Wed); en: Tue + Wed (live streak 2).
    expect(solved(recordWeek([[MON, WED], [TUE, WED]], WED))).toEqual([false, true, true, false, false, false, false]);
  });

  it('never merges two languages into a run neither streak counted', () => {
    // Each language's live streak is 1 on Tuesday: the chain is ONE of them, never Mon + Tue
    // as a run of two the number does not claim.
    const cells = recordWeek([[MON], [TUE]], TUE);
    expect(solved(cells)).toEqual([true, false, false, false, false, false, false]);
    expect(cells.filter((c) => c.solved)).toHaveLength(1);
  });

  it("gives a tie to the first collection (the screen's own language)", () => {
    expect(solved(recordWeek([[WED], [TUE]], WED))[2]).toBe(true);
    expect(solved(recordWeek([[TUE], [WED]], WED))[1]).toBe(true);
  });

  it('is the active week, Monday first, with nothing played', () => {
    const cells = recordWeek([[], []], SUN);
    expect(cells).toHaveLength(7);
    expect(cells[0].dayNumber).toBe(MON);
    expect(cells[6].isToday).toBe(true);
    expect(cells.every((c) => !c.solved)).toBe(true);
  });
});

describe('mondayNarrowLabels — the chain\'s initials', () => {
  it('starts on Monday in both languages', () => {
    expect(mondayNarrowLabels('en')).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(mondayNarrowLabels('fr')).toEqual(['L', 'M', 'M', 'J', 'V', 'S', 'D']);
  });
});
