// THE FACTS A SHARE IS COMMENTED FROM (user-decided 2026-09-07). The bot's lines were empty
// because the writer was handed a band word ("strong") and nothing else; a friend in the
// group reacts to the NUMBERS, and that is where a comment earns its place. Everything here
// is computed by code from the group's own declarations and handed to the model as settled
// facts it may phrase and never revise; nothing is a verdict, and no band word travels.
//
// A SCORE IS READ AGAINST THE SAME DAY'S OTHER SCORES, NEVER AGAINST ANOTHER DAY'S
// (user-decided 2026-09-14). What a day costs depends on its sentence — a 64 can be a
// strong result and a 20 a weak one — so the only readings of a score are where it lands
// among the others who played THAT day, and how that compares with where this player
// usually lands among the others. Until then the facts carried a "typical day" (10–20) and
// each player's average, best and worst SCORE, and the bot told a 43 it was "ta pire
// journée des 14 derniers jours" on the day 43 was fourth of six and 20 won. Nothing here
// carries a score from another day, so no line can be written from one.

import { dateForDayNumber } from '@whippin/shared';
import type { GroupConfig, GroupLanguage } from '../config/groupConfig';
import { inLanguage, type Declaration } from './declarations';
import { displayName } from './names';
import { buildPodium, type NameOf } from './podium';

// How far back a player's form is read. Two weeks: long enough for where somebody usually
// lands to mean something, short enough that it is who they are NOW.
export const FORM_DAYS = 14;

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

function scoreOf(d: Pick<Declaration, 'score' | 'capped'>): Score {
  return d.capped ? '∞' : d.score;
}

// A run that ended at ∞ is behind every finished one and level with another ∞.
function rankOf(d: Pick<Declaration, 'score' | 'capped'>): number {
  return d.capped ? Number.POSITIVE_INFINITY : d.score;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// A share as people SAY it: "3 in 4", never "75%". Handed a percentage, the writer put it
// in a third of its candidates ("tu bats 69% des autres d'habitude"), which nobody types
// about a friend; and the judge read "an average" into it. The nearest speakable fraction,
// with "none" and "all" kept for exactly nobody and exactly everybody.
const SPOKEN: readonly [number, string][] = [
  [0.1, '1 in 10'], [0.25, '1 in 4'], [1 / 3, '1 in 3'], [0.5, '1 in 2'], [2 / 3, '2 in 3'], [0.75, '3 in 4'], [0.9, '9 in 10'],
];

export function spokenShare(share: number): string {
  if (share <= 0) return 'none';
  if (share >= 1) return 'all';
  return SPOKEN.reduce((best, next) => (Math.abs(next[0] - share) < Math.abs(best[0] - share) ? next : best))[1];
}

// The middle of some scores given as ranks (∞ = Infinity, the worst): what "how are the
// others doing" comes down to once there are too many of them to read one by one.
export function medianScore(ranks: readonly number[]): Score | null {
  if (ranks.length === 0) return null;
  const sorted = [...ranks].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const mid = Math.floor(sorted.length / 2);
  const middle = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Number.isFinite(middle) ? round1(middle) : '∞';
}

// WHERE EACH PLAYER OF ONE DAY LANDED AMONG THAT DAY'S OTHERS: the dense place the podium
// prints (null for ∞) and `beats`, the share of the day's OTHER posters they beat, a tie
// counting half — null for somebody who played alone, who beat nobody and lost to nobody.
// The share is what makes two days comparable where the score cannot: second of three and
// fifth of fourteen both read "ahead of most".
export interface DayStanding {
  place: number | null;
  beats: number | null;
}

export function dayStandings(day: number, rows: readonly Declaration[]): Map<string, DayStanding> {
  const played = rows.filter((r) => r.dayNumber === day);
  const podium = buildPodium(day, played);
  const standings = new Map<string, DayStanding>();
  for (const line of podium.lines) for (const p of line.players) standings.set(p.jid, { place: line.position, beats: null });
  for (const p of podium.capped) standings.set(p.jid, { place: null, beats: null });
  for (const row of played) {
    const others = played.filter((o) => o.sender !== row.sender);
    const standing = standings.get(row.sender);
    if (!standing || others.length === 0) continue;
    const mine = rankOf(row);
    const worse = others.filter((o) => rankOf(o) > mine).length;
    const level = others.filter((o) => rankOf(o) === mine).length;
    standing.beats = (worse + level / 2) / others.length;
  }
  return standings;
}

// A player's usual share over some days: the mean of the days they had company on.
export function usualBeats(sender: string, days: readonly Map<string, DayStanding>[]): number | null {
  return mean(days.flatMap((d) => {
    const beats = d.get(sender)?.beats;
    return beats == null ? [] : [beats];
  }));
}

// One day of the window, read once for every player it holds.
interface WindowDay {
  day: number;
  rows: Declaration[];
  standings: Map<string, DayStanding>;
}

// The FORM_DAYS days before `dayNumber`, in the group's language, newest first. The day
// itself is never part of it: a form is what today is read AGAINST.
function readWindow(group: GroupConfig, dayNumber: number, windowRows: readonly Declaration[]): WindowDay[] {
  const window = inLanguage(windowRows, group.language).filter((r) => r.dayNumber < dayNumber && r.dayNumber >= dayNumber - FORM_DAYS);
  return [...new Set(window.map((r) => r.dayNumber))]
    .sort((a, b) => b - a)
    .map((day) => {
      const rows = window.filter((r) => r.dayNumber === day);
      return { day, rows, standings: dayStandings(day, rows) };
    });
}

// "How you did compared to them before", person by person: every day of the window both
// posted, who finished ahead.
export interface Rival {
  name: string;
  together: number; // days of the window both posted
  youBeatThem: number;
  theyBeatYou: number;
  tied: number;
  theyUsuallyBeat: string | null; // how many of the others the rival usually beats: passing somebody who beats everybody is news
}

// WHERE A PLAYER USUALLY LANDS AMONG THE OTHERS, over the window before today — never what
// they usually SCORE (the header says why).
export interface Form {
  name: string;
  daysPlayed: number; // days of the window this player posted
  usuallyBeats: string | null; // how many of a day's other posters they usually beat, spoken ("3 in 4"); null without company
  recent: { date: string; place: number | null; of: number }[]; // newest first; `of` is how many posted; a null place is ∞
  rivals: Rival[]; // everybody else on today's board, best first
}

function formOf(sender: string, name: string, days: readonly WindowDay[], rivals: readonly Declaration[], nameOf: NameOf): Form {
  const standings = days.map((d) => d.standings);
  const share = (jid: string) => {
    const usual = usualBeats(jid, standings);
    return usual === null ? null : spokenShare(usual);
  };
  const played = days.filter((d) => d.standings.has(sender));
  return {
    name,
    daysPlayed: played.length,
    usuallyBeats: share(sender),
    recent: played.map((d) => ({ date: dateForDayNumber(d.day), place: d.standings.get(sender)!.place, of: d.rows.length })),
    rivals: rivals.map((other) => {
      let youBeatThem = 0;
      let theyBeatYou = 0;
      let tied = 0;
      for (const d of days) {
        const mine = d.rows.find((r) => r.sender === sender);
        const theirs = d.rows.find((r) => r.sender === other.sender);
        if (!mine || !theirs) continue;
        if (rankOf(mine) < rankOf(theirs)) youBeatThem += 1;
        else if (rankOf(theirs) < rankOf(mine)) theyBeatYou += 1;
        else tied += 1;
      }
      return { name: nameOf(other), together: youBeatThem + theyBeatYou + tied, youBeatThem, theyBeatYou, tied, theyUsuallyBeat: share(other.sender) };
    }),
  };
}

function boardOf(dayNumber: number, rows: readonly Declaration[], nameOf: NameOf): BoardLine[] {
  const podium = buildPodium(dayNumber, rows, nameOf);
  return [
    ...podium.lines.map((l) => ({ position: l.position, score: l.score as Score, names: l.players.map((p) => p.name) })),
    ...(podium.capped.length ? [{ position: podium.lines.length + 1, score: '∞' as const, names: podium.capped.map((p) => p.name) }] : []),
  ];
}

const byRank = (a: Declaration, b: Declaration) => {
  const ra = rankOf(a);
  const rb = rankOf(b);
  return ra === rb ? 0 : ra < rb ? -1 : 1;
};

export interface ShareContext {
  reading: string; // how to read the rest — the one paragraph both the writer and the judge need
  date: string;
  weekday: string;
  player: string;
  score: Score;
  formDays: number; // how far back `form` looks
  today: {
    posted: number; // this share included
    usualPosters: number | null; // posters on an average played day of the window
    first: boolean;
    board: BoardLine[]; // dense places, this share on it; ∞ runs last, unplaced
    place: number | null; // this player's, null for ∞
    above: string[]; // better scores, best first
    level: string[]; // the same score
    below: string[]; // worse scores (∞ included), worst last
    beats: string | null; // "2 of 5": how many of today's other posters this score beats (level ones not counted); null when alone
    othersMedian: Score | null; // the middle of the others' scores; null when alone
  };
  form: Form; // this player, over the window BEFORE today
}

export const SHARE_READING = `A score is worth something only against the other players' scores of the SAME day (what a day costs depends on its sentence), so nothing here gives a score from another day. "today" is the board so far with this share on it: who is above, level and below, how many of the others this score beats, and the middle of their scores. "form" is the ${FORM_DAYS} days BEFORE today, never today: how many of the other posters this player usually beats, their recent places ("of" = how many posted that day), and their record against each person on today's board over the days both posted, with how many of the others that person usually beats.`;

// `todayRows` is the day's rows WITH this share recorded; `windowRows` is the group's rows
// over the window BEFORE the day (any day of the window, the day itself excluded).
export function buildShareContext(input: {
  group: GroupConfig;
  dayNumber: number;
  sender: string;
  todayRows: readonly Declaration[];
  windowRows: readonly Declaration[];
}): ShareContext | null {
  const { group, dayNumber, sender } = input;
  const nameOf = (d: Declaration) => displayName(group, d.sender, d.name);
  const today = inLanguage(input.todayRows, group.language).filter((r) => r.dayNumber === dayNumber);
  const mine = today.find((r) => r.sender === sender);
  if (!mine) return null;
  const others = today.filter((r) => r.sender !== sender).sort(byRank);
  const standing = dayStandings(dayNumber, today).get(sender)!;
  const days = readWindow(group, dayNumber, input.windowRows);
  const usualPosters = mean(days.map((d) => d.rows.length));
  const date = dateForDayNumber(dayNumber);
  return {
    reading: SHARE_READING,
    date,
    weekday: weekdayOf(date, group.language),
    player: nameOf(mine),
    score: scoreOf(mine),
    formDays: FORM_DAYS,
    today: {
      posted: today.length,
      usualPosters: usualPosters === null ? null : round1(usualPosters),
      first: today.length === 1,
      board: boardOf(dayNumber, today, nameOf),
      place: standing.place,
      above: others.filter((r) => rankOf(r) < rankOf(mine)).map(nameOf),
      level: others.filter((r) => rankOf(r) === rankOf(mine)).map(nameOf),
      below: others.filter((r) => rankOf(r) > rankOf(mine)).map(nameOf),
      beats: others.length ? `${others.filter((r) => rankOf(r) > rankOf(mine)).length} of ${others.length}` : null,
      othersMedian: medianScore(others.map(rankOf)),
    },
    form: formOf(sender, nameOf(mine), days, others, nameOf),
  };
}

// THE FACTS A PODIUM LINE IS COMMENTED FROM (#277): the same readings the share line has —
// the day's board, where each player landed among the others, and each player's form over
// the window before today — computed once for the podium and picked per line. Same
// numbers, same window, same names, so a podium comment and the afternoon's share line
// cannot disagree about who usually lands where.
export interface PodiumContext {
  date: string;
  weekday: string;
  formDays: number;
  board: BoardLine[];
  // By player key: how many of tonight's other players they beat ("2 of 5"), and their form
  // (their rivals being everybody else on tonight's board).
  players: Map<string, { beats: string | null; form: Form }>;
  // By player key, tonight's score as a rank (∞ = Infinity): what a line's "others" are.
  ranks: Map<string, number>;
}

export function buildPodiumContext(input: {
  group: GroupConfig;
  dayNumber: number;
  todayRows: readonly Declaration[];
  windowRows: readonly Declaration[];
}): PodiumContext {
  const { group, dayNumber } = input;
  const nameOf = (d: Declaration) => displayName(group, d.sender, d.name);
  const today = inLanguage(input.todayRows, group.language).filter((r) => r.dayNumber === dayNumber).sort(byRank);
  const standings = dayStandings(dayNumber, today);
  const days = readWindow(group, dayNumber, input.windowRows);
  const players = new Map<string, { beats: string | null; form: Form }>();
  for (const row of today) {
    const others = today.filter((r) => r.sender !== row.sender);
    players.set(row.sender, {
      beats: others.length ? `${others.filter((r) => rankOf(r) > rankOf(row)).length} of ${others.length}` : null,
      form: formOf(row.sender, nameOf(row), days, others, nameOf),
    });
  }
  const date = dateForDayNumber(dayNumber);
  return {
    date,
    weekday: weekdayOf(date, group.language),
    formDays: FORM_DAYS,
    board: boardOf(dayNumber, today, nameOf),
    players,
    ranks: new Map(today.map((r) => [r.sender, rankOf(r)])),
  };
}
