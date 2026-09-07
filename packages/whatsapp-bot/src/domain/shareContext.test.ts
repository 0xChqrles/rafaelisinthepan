import { dateForDayNumber } from '@whippin/shared';
import { describe, expect, it } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import type { Declaration } from './declarations';
import { HABIT_DAYS, TYPICAL_SCORE, buildShareContext } from './shareContext';

const group = parseGroupConfig('g.json', {
  id: '120363000000000001@g.us',
  name: 'g',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true, prePrompt: '' },
});
const DAY = 20700;
function row(day: number, sender: string, score: number, capped = false, lang = 'fr'): Declaration {
  return {
    group: group.id, dayNumber: day, sender, score, capped, token: `t-${day}-${sender}`, messageId: `m-${day}-${sender}`,
    messageTs: 1, name: sender.toUpperCase(), receivedAt: '2026-09-07T10:00:00.000Z', lang,
  };
}

describe('the facts a share is commented from (user-decided 2026-09-07)', () => {
  it('reads the day as a dense board with this player placed, and who is ahead, level and behind', () => {
    const today = [row(DAY, 'luc', 4), row(DAY, 'bruno', 21), row(DAY, 'cami', 12), row(DAY, 'zou', 12), row(DAY, 'theo', 500, true)];
    const ctx = buildShareContext({ group, dayNumber: DAY, sender: 'cami', todayRows: today, windowRows: [] });
    expect(ctx).not.toBeNull();
    expect(ctx!.score).toBe(12);
    expect(ctx!.typical).toEqual(TYPICAL_SCORE);
    expect(ctx!.habitDays).toBe(HABIT_DAYS);
    expect(ctx!.today.board).toEqual([
      { position: 1, score: 4, names: ['LUC'] },
      { position: 2, score: 12, names: ['CAMI', 'ZOU'] },
      { position: 3, score: 21, names: ['BRUNO'] },
      { position: 4, score: '∞', names: ['THEO'] },
    ]);
    expect(ctx!.today).toMatchObject({ postedSoFar: 5, firstOfDay: false, position: 2, ahead: ['LUC'], level: ['ZOU'], behind: ['BRUNO', 'THEO'] });
    // A ∞ run has no position, and sits behind everybody.
    const capped = buildShareContext({ group, dayNumber: DAY, sender: 'theo', todayRows: today, windowRows: [] })!;
    expect(capped.score).toBe('∞');
    expect(capped.today.position).toBeNull();
    expect(capped.today.ahead).toEqual(['LUC', 'CAMI', 'ZOU', 'BRUNO']);
  });

  it('the first share of the day says so, with how many usually post', () => {
    const window = [row(DAY - 1, 'luc', 5), row(DAY - 1, 'bruno', 9), row(DAY - 1, 'cami', 30), row(DAY - 2, 'luc', 7)];
    const ctx = buildShareContext({ group, dayNumber: DAY, sender: 'luc', todayRows: [row(DAY, 'luc', 6)], windowRows: window })!;
    expect(ctx.today).toMatchObject({ postedSoFar: 1, firstOfDay: true, position: 1, ahead: [], behind: [], usualPosters: 2 });
    expect(ctx.today.board).toEqual([{ position: 1, score: 6, names: ['LUC'] }]);
  });

  it("this player's habit and recent days come from the window BEFORE the day, positioned among that day's posters", () => {
    const window = [
      row(DAY - 1, 'luc', 5), row(DAY - 1, 'bruno', 9),
      row(DAY - 2, 'luc', 20), row(DAY - 2, 'bruno', 8), row(DAY - 2, 'cami', 11),
      row(DAY - 3, 'bruno', 500, true), row(DAY - 3, 'luc', 3),
      row(DAY - HABIT_DAYS - 1, 'bruno', 4), // outside the window
      row(DAY, 'bruno', 100), // the day itself is never habit
    ];
    const ctx = buildShareContext({ group, dayNumber: DAY, sender: 'bruno', todayRows: [row(DAY, 'luc', 6), row(DAY, 'bruno', 14)], windowRows: window })!;
    expect(ctx.habit).toEqual({ name: 'BRUNO', daysPlayed: 3, averageScore: 8.5, averagePosition: 1.5, best: 8, worst: '∞' });
    expect(ctx.recent).toEqual([
      { date: dateForDayNumber(DAY - 1), score: 9, position: 2, posters: 2 },
      { date: dateForDayNumber(DAY - 2), score: 8, position: 1, posters: 3 },
      { date: dateForDayNumber(DAY - 3), score: '∞', position: null, posters: 2 },
    ]);
    // Everybody else on today's board, with their habit, best first.
    expect(ctx.others).toEqual([{ name: 'LUC', daysPlayed: 3, averageScore: 9.3, averagePosition: 1.7, best: 3, worst: 20 }]);
    expect(ctx.today.usualPosters).toBe(2.3);
  });

  it('reads only the group language, and answers null when the sender has no row that day', () => {
    const today = [row(DAY, 'luc', 4, false, 'en'), row(DAY, 'bruno', 9)];
    expect(buildShareContext({ group, dayNumber: DAY, sender: 'luc', todayRows: today, windowRows: [] })).toBeNull();
    expect(buildShareContext({ group, dayNumber: DAY, sender: 'bruno', todayRows: today, windowRows: [] })!.today.postedSoFar).toBe(1);
  });
});
