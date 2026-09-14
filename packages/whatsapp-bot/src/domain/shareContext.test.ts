import { dateForDayNumber } from '@whippin/shared';
import { describe, expect, it } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import type { Declaration } from './declarations';
import { FORM_DAYS, SHARE_READING, buildPodiumContext, buildShareContext, medianScore, spokenShare } from './shareContext';

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

// Bruno's window: behind Luc, ahead of Luc and Cami, ∞ behind Luc, level with Luc — and
// one day outside the window, and the day itself, neither of which is form.
const WINDOW = [
  row(DAY - 1, 'luc', 5), row(DAY - 1, 'bruno', 9),
  row(DAY - 2, 'luc', 20), row(DAY - 2, 'bruno', 8), row(DAY - 2, 'cami', 11),
  row(DAY - 3, 'bruno', 500, true), row(DAY - 3, 'luc', 3),
  row(DAY - 4, 'bruno', 7), row(DAY - 4, 'luc', 7),
  row(DAY - FORM_DAYS - 1, 'bruno', 4), // outside the window
  row(DAY, 'bruno', 100), // the day itself is never form
];

describe('the facts a share is commented from (user-decided 2026-09-07; relative since 2026-09-14)', () => {
  it('reads the day as a dense board with this player placed: who is above, level and below, and the share of the others it beats', () => {
    const today = [row(DAY, 'luc', 4), row(DAY, 'bruno', 21), row(DAY, 'cami', 12), row(DAY, 'zou', 12), row(DAY, 'theo', 500, true)];
    const ctx = buildShareContext({ group, dayNumber: DAY, sender: 'cami', todayRows: today, windowRows: [] })!;
    expect(ctx.score).toBe(12);
    expect(ctx.formDays).toBe(FORM_DAYS);
    expect(ctx.reading).toBe(SHARE_READING);
    expect(ctx.today.board).toEqual([
      { position: 1, score: 4, names: ['LUC'] },
      { position: 2, score: 12, names: ['CAMI', 'ZOU'] },
      { position: 3, score: 21, names: ['BRUNO'] },
      { position: 4, score: '∞', names: ['THEO'] },
    ]);
    // Beats Bruno and Theo, level with Zou (not counted), behind Luc.
    expect(ctx.today).toMatchObject({ posted: 5, first: false, place: 2, above: ['LUC'], level: ['ZOU'], below: ['BRUNO', 'THEO'], beats: '2 of 4', othersMedian: 16.5 });
    // A ∞ run has no place, sits behind everybody and beats nobody.
    const capped = buildShareContext({ group, dayNumber: DAY, sender: 'theo', todayRows: today, windowRows: [] })!;
    expect(capped.score).toBe('∞');
    expect(capped.today).toMatchObject({ place: null, above: ['LUC', 'CAMI', 'ZOU', 'BRUNO'], below: [], beats: '0 of 4', othersMedian: 12 });
  });

  it('the first share of the day has nobody to be compared with: no share, no median, and how many usually post', () => {
    const window = [row(DAY - 1, 'luc', 5), row(DAY - 1, 'bruno', 9), row(DAY - 1, 'cami', 30), row(DAY - 2, 'luc', 7)];
    const ctx = buildShareContext({ group, dayNumber: DAY, sender: 'luc', todayRows: [row(DAY, 'luc', 6)], windowRows: window })!;
    expect(ctx.today).toMatchObject({ posted: 1, first: true, place: 1, above: [], below: [], level: [], beats: null, othersMedian: null, usualPosters: 2 });
    expect(ctx.today.board).toEqual([{ position: 1, score: 6, names: ['LUC'] }]);
    // Alone on the 2nd day beats nobody and loses to nobody: that day says nothing of form.
    expect(ctx.form).toMatchObject({ daysPlayed: 2, usuallyBeats: 'all', rivals: [] });
  });

  it("this player's FORM is where they usually land among the others over the window BEFORE the day — places, never scores", () => {
    const ctx = buildShareContext({ group, dayNumber: DAY, sender: 'bruno', todayRows: [row(DAY, 'luc', 6), row(DAY, 'bruno', 14)], windowRows: WINDOW })!;
    expect(ctx.today).toMatchObject({ place: 2, above: ['LUC'], beats: '0 of 1', othersMedian: 6, usualPosters: 2.3 });
    // Bruno beat nobody on the 1st, both on the 2nd, nobody on the 3rd (∞), half on the
    // 4th (level): (0 + 1 + 0 + 0.5) / 4 = 0.375, said as people say it.
    expect(ctx.form).toEqual({
      name: 'BRUNO',
      daysPlayed: 4,
      usuallyBeats: '1 in 3',
      recent: [
        { date: dateForDayNumber(DAY - 1), place: 2, of: 2 },
        { date: dateForDayNumber(DAY - 2), place: 1, of: 3 },
        { date: dateForDayNumber(DAY - 3), place: null, of: 2 },
        { date: dateForDayNumber(DAY - 4), place: 1, of: 2 },
      ],
      // "How you did compared to them before": every day both posted, and Luc's own form.
      rivals: [{ name: 'LUC', together: 4, youBeatThem: 1, theyBeatYou: 2, tied: 1, theyUsuallyBeat: '2 in 3' }],
    });
  });

  it('carries NO score from another day, anywhere — the one reading of a score it no longer allows', () => {
    const window = [row(DAY - 1, 'luc', 417), row(DAY - 1, 'bruno', 471), row(DAY - 2, 'bruno', 499), row(DAY - 2, 'cami', 433)];
    const today = [row(DAY, 'luc', 6), row(DAY, 'bruno', 14), row(DAY, 'cami', 9)];
    const share = JSON.stringify(buildShareContext({ group, dayNumber: DAY, sender: 'bruno', todayRows: today, windowRows: window }));
    expect(share).not.toMatch(/417|471|499|433/);
    expect(share).not.toMatch(/"(typical|habit|averageScore|averagePosition|best|worst)"/);
    const podium = buildPodiumContext({ group, dayNumber: DAY, todayRows: today, windowRows: window });
    expect(JSON.stringify([...podium.players.values()])).not.toMatch(/417|471|499|433/);
  });

  it('reads only the group language, and answers null when the sender has no row that day', () => {
    const today = [row(DAY, 'luc', 4, false, 'en'), row(DAY, 'bruno', 9)];
    expect(buildShareContext({ group, dayNumber: DAY, sender: 'luc', todayRows: today, windowRows: [] })).toBeNull();
    expect(buildShareContext({ group, dayNumber: DAY, sender: 'bruno', todayRows: today, windowRows: [] })!.today.posted).toBe(1);
  });

  it('the podium reads every player the same way, their rivals being everybody else on the night', () => {
    const podium = buildPodiumContext({ group, dayNumber: DAY, todayRows: [row(DAY, 'luc', 6), row(DAY, 'bruno', 14)], windowRows: WINDOW });
    expect(podium.board).toEqual([{ position: 1, score: 6, names: ['LUC'] }, { position: 2, score: 14, names: ['BRUNO'] }]);
    expect(podium.players.get('luc')).toMatchObject({ beats: '1 of 1', form: { usuallyBeats: '2 in 3', rivals: [{ name: 'BRUNO', youBeatThem: 2, theyBeatYou: 1, tied: 1 }] } });
    // The share line and the podium cannot disagree about who usually lands where.
    const share = buildShareContext({ group, dayNumber: DAY, sender: 'bruno', todayRows: [row(DAY, 'luc', 6), row(DAY, 'bruno', 14)], windowRows: WINDOW })!;
    expect(podium.players.get('bruno')).toEqual({ beats: share.today.beats, form: share.form });
  });

  it('a share is said the way people say it: never a percentage, none and all only when exact', () => {
    expect([0, 0.05, 0.2, 0.375, 0.54, 0.69, 0.71, 0.95, 1].map(spokenShare)).toEqual(
      ['none', '1 in 10', '1 in 4', '1 in 3', '1 in 2', '2 in 3', '3 in 4', '9 in 10', 'all'],
    );
  });

  it('the middle of the others counts ∞ as the worst', () => {
    expect(medianScore([])).toBeNull();
    expect(medianScore([5])).toBe(5);
    expect(medianScore([21, 4, Infinity, 12])).toBe(16.5);
    expect(medianScore([3, Infinity])).toBe('∞');
    expect(medianScore([Infinity, 2, Infinity])).toBe('∞');
  });
});
