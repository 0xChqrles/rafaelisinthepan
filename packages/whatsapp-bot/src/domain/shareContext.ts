// THE FACTS A SHARE IS COMMENTED FROM (user-decided 2026-09-07). The bot's lines were empty
// because the writer was handed a band word ("strong") and nothing else; a friend in the
// group reacts to the NUMBERS — the score against what a day usually costs, against who
// has posted so far, against what this player usually does — and that is where a comment
// earns its place. Everything here is computed by code from the group's own declarations
// and handed to the model as settled facts it may phrase and never revise; nothing is a
// verdict, and no band word travels with it.

import { dateForDayNumber } from '@whippin/shared';
import type { GroupConfig, GroupLanguage } from '../config/groupConfig';
import { inLanguage, type Declaration } from './declarations';
import { displayName } from './names';
import { buildPodium } from './podium';

// What a day usually costs, for the model to calibrate a score before anybody else has
// posted: the group's recorded scores sit at median ~14, quartiles 9 and 23 (2026-09-04,
// `reactions.ts`), and the user reads "a median between 10 and 20".
export const TYPICAL_SCORE = { low: 10, high: 20, median: 14 } as const;
// How far back a player's habit is read. Two weeks: long enough for an average position
// to mean something, short enough that it is who they are NOW.
export const HABIT_DAYS = 14;

// THE WEEKDAY IS A FACT THE MODEL IS GIVEN, never one it works out (#277): told only a
// date, the podium comments wrote "pour un mardi" on a Wednesday. Spelled in the group's
// language, so the line can say it as it is.
export function weekdayOf(date: string, language: GroupLanguage): string {
  return new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

export type Score = number | '∞';

export interface BoardLine {
  position: number;
  score: Score;
  names: string[];
}

export interface PlayerHabit {
  name: string;
  daysPlayed: number;
  averageScore: number | null; // finite scores only
  averagePosition: number | null; // dense position among that day's posters
  best: number | null;
  worst: Score | null;
}

export interface ShareContext {
  reading: string; // how to read the rest — the one sentence both the writer and the judge need
  date: string;
  weekday: string;
  player: string;
  score: Score;
  typical: typeof TYPICAL_SCORE;
  habitDays: number; // how far back `habit`, `recent` and `others` look — a "record" is a record of THIS window
  today: {
    postedSoFar: number; // this share included
    usualPosters: number | null; // average posters per played day in the window
    firstOfDay: boolean;
    board: BoardLine[]; // dense positions, this share included; ∞ runs last, unplaced
    position: number | null; // this player's position, null for ∞
    ahead: string[]; // strictly better scores, best first
    behind: string[]; // strictly worse scores (∞ included), worst last
    level: string[]; // the same score
  };
  habit: PlayerHabit; // this player, over the window BEFORE today
  recent: { date: string; score: Score; position: number | null; posters: number }[]; // this player, newest first
  others: PlayerHabit[]; // everybody else on today's board
}

function scoreOf(d: Pick<Declaration, 'score' | 'capped'>): Score {
  return d.capped ? '∞' : d.score;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function habitOf(name: string, rows: readonly Declaration[], positions: Map<string, number | null>[]): PlayerHabit {
  const finite = rows.filter((r) => !r.capped).map((r) => r.score);
  const placed = positions.map((p) => p.get(rows[0]?.sender ?? '')).filter((p): p is number => typeof p === 'number');
  const worst = rows.some((r) => r.capped) ? '∞' : finite.length ? Math.max(...finite) : null;
  return {
    name,
    daysPlayed: rows.length,
    averageScore: finite.length ? round1(finite.reduce((a, b) => a + b, 0) / finite.length) : null,
    averagePosition: placed.length ? round1(placed.reduce((a, b) => a + b, 0) / placed.length) : null,
    best: finite.length ? Math.min(...finite) : null,
    worst,
  };
}

// `todayRows` is the day's rows WITH this share recorded; `windowRows` is the group's
// rows over the window BEFORE the day (any day of the window, the day itself excluded).
export function buildShareContext(input: {
  group: GroupConfig;
  dayNumber: number;
  sender: string;
  todayRows: readonly Declaration[];
  windowRows: readonly Declaration[];
}): ShareContext | null {
  const { group, dayNumber, sender } = input;
  const nameOf = (d: Declaration) => displayName(group, d.sender, d.name);
  const today = inLanguage(input.todayRows, group.language);
  const mine = today.find((r) => r.sender === sender);
  if (!mine) return null;
  const score = scoreOf(mine);
  const podium = buildPodium(dayNumber, today, nameOf);
  const board: BoardLine[] = [
    ...podium.lines.map((l) => ({ position: l.position, score: l.score as Score, names: l.players.map((p) => p.name) })),
    ...(podium.capped.length ? [{ position: podium.lines.length + 1, score: '∞' as const, names: podium.capped.map((p) => p.name) }] : []),
  ];
  const rank = (r: Declaration) => (r.capped ? Infinity : r.score);
  const others = today.filter((r) => r.sender !== sender);
  const byRank = (a: Declaration, b: Declaration) => rank(a) - rank(b);

  const window = inLanguage(input.windowRows, group.language).filter((r) => r.dayNumber < dayNumber && r.dayNumber >= dayNumber - HABIT_DAYS);
  const days = [...new Set(window.map((r) => r.dayNumber))].sort((a, b) => b - a);
  // Positions per day, dense, ∞ unplaced — the same reading the podium prints.
  const positionsByDay = days.map((day) => {
    const rows = window.filter((r) => r.dayNumber === day);
    const p = buildPodium(day, rows, nameOf);
    const m = new Map<string, number | null>();
    for (const line of p.lines) for (const player of line.players) m.set(player.jid, line.position);
    for (const player of p.capped) m.set(player.jid, null);
    return m;
  });
  const postersByDay = days.map((day) => window.filter((r) => r.dayNumber === day).length);
  const habitFor = (jid: string, name: string) =>
    habitOf(name, window.filter((r) => r.sender === jid).sort((a, b) => b.dayNumber - a.dayNumber), positionsByDay);

  return {
    reading: `today's score is "score"; "habit", "recent" and "others" cover the ${HABIT_DAYS} days BEFORE today and do not include it, so today's score compared to habit.best / habit.worst tells whether today is this player's best or worst of the window, today included; "today" is the board with this share on it`,
    date: dateForDayNumber(dayNumber),
    weekday: weekdayOf(dateForDayNumber(dayNumber), group.language),
    player: nameOf(mine),
    score,
    typical: TYPICAL_SCORE,
    habitDays: HABIT_DAYS,
    today: {
      postedSoFar: today.length,
      usualPosters: postersByDay.length ? round1(postersByDay.reduce((a, b) => a + b, 0) / postersByDay.length) : null,
      firstOfDay: today.length === 1,
      board,
      position: mine.capped ? null : (podium.lines.find((l) => l.players.some((p) => p.jid === sender))?.position ?? null),
      ahead: others.filter((r) => rank(r) < rank(mine)).sort(byRank).map(nameOf),
      behind: others.filter((r) => rank(r) > rank(mine)).sort(byRank).map(nameOf),
      level: others.filter((r) => rank(r) === rank(mine)).map(nameOf),
    },
    habit: habitFor(sender, nameOf(mine)),
    recent: window
      .filter((r) => r.sender === sender)
      .sort((a, b) => b.dayNumber - a.dayNumber)
      .map((r) => ({
        date: dateForDayNumber(r.dayNumber),
        score: scoreOf(r),
        position: positionsByDay[days.indexOf(r.dayNumber)]?.get(sender) ?? null,
        posters: postersByDay[days.indexOf(r.dayNumber)] ?? 0,
      })),
    others: others.sort(byRank).map((r) => habitFor(r.sender, nameOf(r))),
  };
}

// THE FACTS A PODIUM LINE IS COMMENTED FROM (#277): the same readings the share line has —
// the day's board, what a day usually costs, every player's habit and recent days over the
// window before today — computed once for the podium and picked per line. Same numbers,
// same window, same names, so a podium comment and the afternoon's share line cannot
// disagree about who usually does what.
export interface PodiumContext {
  date: string;
  weekday: string;
  typical: typeof TYPICAL_SCORE;
  habitDays: number;
  usualPosters: number | null;
  board: BoardLine[];
  // By player key: their habit over the window, and their recent days, newest first.
  players: Map<string, { habit: PlayerHabit; recent: ShareContext['recent'] }>;
}

export function buildPodiumContext(input: {
  group: GroupConfig;
  dayNumber: number;
  todayRows: readonly Declaration[];
  windowRows: readonly Declaration[];
}): PodiumContext {
  const { group, dayNumber } = input;
  const nameOf = (d: Declaration) => displayName(group, d.sender, d.name);
  const today = inLanguage(input.todayRows, group.language);
  const podium = buildPodium(dayNumber, today, nameOf);
  const board: BoardLine[] = [
    ...podium.lines.map((l) => ({ position: l.position, score: l.score as Score, names: l.players.map((p) => p.name) })),
    ...(podium.capped.length ? [{ position: podium.lines.length + 1, score: '∞' as const, names: podium.capped.map((p) => p.name) }] : []),
  ];
  const window = inLanguage(input.windowRows, group.language).filter((r) => r.dayNumber < dayNumber && r.dayNumber >= dayNumber - HABIT_DAYS);
  const days = [...new Set(window.map((r) => r.dayNumber))].sort((a, b) => b - a);
  const positionsByDay = days.map((day) => {
    const rows = window.filter((r) => r.dayNumber === day);
    const p = buildPodium(day, rows, nameOf);
    const m = new Map<string, number | null>();
    for (const line of p.lines) for (const player of line.players) m.set(player.jid, line.position);
    for (const player of p.capped) m.set(player.jid, null);
    return m;
  });
  const postersByDay = days.map((day) => window.filter((r) => r.dayNumber === day).length);
  const players = new Map<string, { habit: PlayerHabit; recent: ShareContext['recent'] }>();
  for (const row of today) {
    const mine = window.filter((r) => r.sender === row.sender).sort((a, b) => b.dayNumber - a.dayNumber);
    players.set(row.sender, {
      habit: habitOf(nameOf(row), mine, positionsByDay),
      recent: mine.map((r) => ({
        date: dateForDayNumber(r.dayNumber),
        score: scoreOf(r),
        position: positionsByDay[days.indexOf(r.dayNumber)]?.get(r.sender) ?? null,
        posters: postersByDay[days.indexOf(r.dayNumber)] ?? 0,
      })),
    });
  }
  return {
    date: dateForDayNumber(dayNumber),
    weekday: weekdayOf(dateForDayNumber(dayNumber), group.language),
    typical: TYPICAL_SCORE,
    habitDays: HABIT_DAYS,
    usualPosters: postersByDay.length ? round1(postersByDay.reduce((a, b) => a + b, 0) / postersByDay.length) : null,
    board,
    players,
  };
}
