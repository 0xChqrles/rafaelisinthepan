// Whippin facts come through TOOLS (#236): narrow, bot-owned, read-only readings of the
// group's declarations, each taking resolved parameters and returning a small structured
// answer the model turns into language. The runner is an ALLOW-LIST — the model never
// chooses a DynamoDB key, a URL or an AWS operation — and player-NAME resolution is the
// bot's concern: a name is matched against the JIDs the group has seen and the operator's
// overrides, and an ambiguous or unknown one is answered as exactly that, never guessed.

import { dateForDayNumber, fold } from '@whippin/shared';
import type { GroupConfig } from '../config/groupConfig';
import {
  inLanguage,
  playersIn,
  type Declaration,
  type DeclarationStore,
  type PlayerSummary,
} from '../domain/declarations';
import { parseDay } from '../domain/day';
import { buildPodium } from '../domain/podium';
import { displayName } from '../domain/names';
import type { LlmTool } from '../llm/types';
import { withFact, type MemoryStore } from './memory';

export const HISTORY_WINDOW_DAYS = 60; // how far back the resolution universe and records look
const DEFAULT_DAYS = 7;
const RECORDS_DEFAULT_DAYS = 30;
// A window may never exceed what is actually READ. Accepting 90 while `history()` reads 60
// answers sixty days of rows under the label `windowDays: 90`, which is a wrong number
// reported confidently — the one thing these tools exist to prevent. One constant, and the
// tool descriptions below are built from it so the model is never told otherwise.
const MAX_DAYS = HISTORY_WINDOW_DAYS;

export interface ToolContext {
  group: GroupConfig;
  today: number; // active Whippin dayNumber
  sender: string; // the person asking — the only JID `remember` may write about
  declarations: DeclarationStore;
  memory: MemoryStore;
  now: () => Date;
}

export type Resolution =
  | { kind: 'one'; player: PlayerSummary }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown'; known: string[] };

function norm(s: string): string {
  return fold(s);
}

// Exact (folded) match first, on the operator override or the latest snapshot; then a
// prefix match. Several hits are AMBIGUOUS, none is UNKNOWN — both spelled out with the
// names the model can offer back to the person.
export function resolvePlayer(
  query: string,
  players: readonly PlayerSummary[],
  group: GroupConfig,
): Resolution {
  const q = norm(query);
  const labelled = players.map((p) => ({ player: p, name: displayName(group, p.sender, p.name) }));
  const byJid = labelled.find(({ player }) => player.sender === query.trim());
  if (byJid) return { kind: 'one', player: byJid.player };
  if (q === '') return { kind: 'unknown', known: labelled.map((l) => l.name) };
  const exact = labelled.filter(({ name }) => norm(name) === q);
  const hits = exact.length > 0 ? exact : labelled.filter(({ name }) => norm(name).startsWith(q));
  if (hits.length === 1) return { kind: 'one', player: hits[0].player };
  if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.map((h) => h.name) };
  return { kind: 'unknown', known: labelled.map((l) => l.name) };
}

function clampDays(raw: unknown, fallback: number = DEFAULT_DAYS): number {
  // A model that sends "30" means thirty, not "I did not say" — reading that as the
  // default silently answers a different question from the one asked.
  const asNumber = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  const days = Number.isFinite(asNumber) ? Math.floor(asNumber) : fallback;
  return Math.min(MAX_DAYS, Math.max(1, days));
}

function scoreOf(d: Declaration): number | '∞' {
  return d.capped ? '∞' : d.score;
}

function dayOf(rows: readonly Declaration[], day: number): Declaration[] {
  return rows.filter((r) => r.dayNumber === day);
}

// Days (within the window) on which `jid` held position 1 — alone or shared.
function wonDays(rows: readonly Declaration[], jid: string): Set<number> {
  const days = new Set(rows.map((r) => r.dayNumber));
  const won = new Set<number>();
  for (const day of days) {
    const podium = buildPodium(day, dayOf(rows, day));
    if (podium.lines[0]?.players.some((p) => p.jid === jid)) won.add(day);
  }
  return won;
}

export const TOOL_DEFINITIONS: LlmTool[] = [
  {
    name: 'get_today_podium',
    description: "Today's podium in this group: dense positions, scores (lower is better) and names.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_player_score',
    description: "One player's declared score on a day (default today).",
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string', description: 'Name as used in the group' },
        date: { type: 'string', description: 'YYYY-MM-DD; omit for today' },
      },
      required: ['player'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_player_history',
    description: "A player's scores over the last N days, with best and average.",
    parameters: {
      type: 'object',
      properties: {
        player: { type: 'string' },
        days: { type: 'integer', description: `Window in days, default ${DEFAULT_DAYS}, max ${MAX_DAYS}` },
      },
      required: ['player'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_head_to_head',
    description: 'Two players compared over the days both played in the last N days: wins each way, ties, who is ahead and their current run.',
    parameters: {
      type: 'object',
      properties: {
        left: { type: 'string' },
        right: { type: 'string' },
        days: { type: 'integer', description: `Window in days, default ${DEFAULT_DAYS}, max ${MAX_DAYS}` },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_win_streak',
    description: "How many consecutive days (ending today or yesterday) a player has held the group's first position.",
    parameters: {
      type: 'object',
      properties: { player: { type: 'string' } },
      required: ['player'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_group_records',
    description: 'Group records over the last N days: best score, most podium wins, most days played.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: `Window in days, default ${RECORDS_DEFAULT_DAYS}, max ${MAX_DAYS}`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'remember',
    description: 'Save one short fact the person you are talking to explicitly told you about THEMSELVES (a nickname they prefer, a rivalry, a habit). Never about someone else, never a guess.',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'One plain sentence, at most 120 characters' } },
      required: ['fact'],
      additionalProperties: false,
    },
  },
];

export interface ToolRunner {
  definitions: LlmTool[];
  run(name: string, args: unknown): Promise<unknown>;
}

export function createToolRunner(ctx: ToolContext): ToolRunner {
  const nameOf = (d: Declaration) => displayName(ctx.group, d.sender, d.name);
  // Every read is the group's own language (see `inLanguage`): a tool must not answer a
  // question about this group's daily with rows from the one it used to play.
  const ownLanguage = (rows: readonly Declaration[]) => inLanguage(rows, ctx.group.language);
  let windowRows: Promise<Declaration[]> | undefined;
  const history = () =>
    (windowRows ??= ctx.declarations
      .range(ctx.group.id, ctx.today - HISTORY_WINDOW_DAYS, ctx.today)
      .then(ownLanguage));
  const players = async () => playersIn(await history());

  async function resolve(raw: unknown): Promise<Resolution | { error: string }> {
    if (typeof raw !== 'string') return { error: 'player must be a name' };
    return resolvePlayer(raw, await players(), ctx.group);
  }

  const notOne = (r: Resolution | { error: string }) =>
    'error' in r
      ? r
      : r.kind === 'ambiguous'
        ? { ambiguous: r.candidates }
        : r.kind === 'unknown'
          ? { unknown: true, knownPlayers: r.known }
          : null;

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    async get_today_podium() {
      const today = ownLanguage(await ctx.declarations.day(ctx.group.id, ctx.today));
      const podium = buildPodium(ctx.today, today, nameOf);
      return {
        date: dateForDayNumber(ctx.today),
        lines: podium.lines.map((l) => ({
          position: l.position,
          score: l.score,
          names: l.players.map((p) => p.name),
        })),
        unfinished: podium.capped.map((p) => p.name),
      };
    },
    async get_player_score(args) {
      const r = await resolve(args.player);
      const bad = notOne(r);
      if (bad) return bad;
      const player = (r as { player: PlayerSummary }).player;
      // A date the model invented ("2026-02-30") is refused, not rolled over into a
      // neighbouring day whose numbers it would then report as the answer.
      const day = args.date == null ? ctx.today : parseDay(args.date);
      if (day === null) return { error: 'date must be a real calendar date, YYYY-MM-DD' };
      // A day that has not happened has no result, and "played: false" would read as
      // "they skipped it" about a puzzle nobody has seen.
      if (day > ctx.today) return { error: 'that day has not been played yet' };
      const rows =
        day === ctx.today || day < ctx.today - HISTORY_WINDOW_DAYS
          ? ownLanguage(await ctx.declarations.day(ctx.group.id, day))
          : dayOf(await history(), day);
      const row = rows.find((x) => x.sender === player.sender);
      const podium = buildPodium(day, rows, nameOf);
      const line = podium.lines.find((l) => l.players.some((p) => p.jid === player.sender));
      return {
        player: nameOf({ ...row, sender: player.sender, name: player.name } as Declaration),
        date: dateForDayNumber(day),
        played: row !== undefined,
        score: row ? scoreOf(row) : null,
        position: line?.position ?? null,
        playersThatDay: rows.length,
      };
    },
    async get_player_history(args) {
      const r = await resolve(args.player);
      const bad = notOne(r);
      if (bad) return bad;
      const player = (r as { player: PlayerSummary }).player;
      const days = clampDays(args.days);
      const rows = (await history()).filter(
        (x) => x.sender === player.sender && x.dayNumber > ctx.today - days,
      );
      const finite = rows.filter((x) => !x.capped).map((x) => x.score);
      return {
        player: displayName(ctx.group, player.sender, player.name),
        windowDays: days,
        results: rows.map((x) => ({ date: dateForDayNumber(x.dayNumber), score: scoreOf(x) })),
        daysPlayed: rows.length,
        best: finite.length ? Math.min(...finite) : null,
        average: finite.length ? Math.round((finite.reduce((a, b) => a + b, 0) / finite.length) * 10) / 10 : null,
      };
    },
    async get_head_to_head(args) {
      const [l, rr] = await Promise.all([resolve(args.left), resolve(args.right)]);
      const badL = notOne(l);
      if (badL) return { left: badL };
      const badR = notOne(rr);
      if (badR) return { right: badR };
      const left = (l as { player: PlayerSummary }).player;
      const right = (rr as { player: PlayerSummary }).player;
      const days = clampDays(args.days);
      const rows = (await history()).filter((x) => x.dayNumber > ctx.today - days);
      let leftWins = 0;
      let rightWins = 0;
      let ties = 0;
      let streakOwner: 'left' | 'right' | null = null;
      let streak = 0;
      const played = [...new Set(rows.map((x) => x.dayNumber))].sort((a, b) => a - b);
      for (const day of played) {
        const a = rows.find((x) => x.dayNumber === day && x.sender === left.sender);
        const b = rows.find((x) => x.dayNumber === day && x.sender === right.sender);
        if (!a || !b) continue;
        const sa = a.capped ? Infinity : a.score;
        const sb = b.capped ? Infinity : b.score;
        const winner: 'left' | 'right' | null = sa < sb ? 'left' : sb < sa ? 'right' : null;
        if (winner === 'left') leftWins += 1;
        else if (winner === 'right') rightWins += 1;
        else ties += 1;
        if (winner === null) continue;
        if (winner === streakOwner) streak += 1;
        else {
          streakOwner = winner;
          streak = 1;
        }
      }
      const leftName = displayName(ctx.group, left.sender, left.name);
      const rightName = displayName(ctx.group, right.sender, right.name);
      return {
        left: leftName,
        right: rightName,
        windowDays: days,
        daysBothPlayed: leftWins + rightWins + ties,
        leftWins,
        rightWins,
        ties,
        currentWinner: streakOwner === 'left' ? leftName : streakOwner === 'right' ? rightName : null,
        currentStreak: streak,
      };
    },
    async get_win_streak(args) {
      const r = await resolve(args.player);
      const bad = notOne(r);
      if (bad) return bad;
      const player = (r as { player: PlayerSummary }).player;
      const rows = await history();
      const won = wonDays(rows, player.sender);
      // Count back from today, or from yesterday if today has no rows yet.
      let day = dayOf(rows, ctx.today).length > 0 ? ctx.today : ctx.today - 1;
      let streak = 0;
      while (won.has(day)) {
        streak += 1;
        day -= 1;
      }
      return { player: displayName(ctx.group, player.sender, player.name), streak };
    },
    async get_group_records(args) {
      const days = clampDays(args.days, RECORDS_DEFAULT_DAYS);
      const rows = (await history()).filter((x) => x.dayNumber > ctx.today - days);
      const finite = rows.filter((x) => !x.capped);
      const best = finite.reduce<Declaration | null>((b, x) => (!b || x.score < b.score ? x : b), null);
      const wins = new Map<string, number>();
      const playedCount = new Map<string, number>();
      for (const x of rows) playedCount.set(x.sender, (playedCount.get(x.sender) ?? 0) + 1);
      for (const day of new Set(rows.map((x) => x.dayNumber))) {
        for (const p of buildPodium(day, dayOf(rows, day)).lines[0]?.players ?? []) {
          wins.set(p.jid, (wins.get(p.jid) ?? 0) + 1);
        }
      }
      const label = (jid: string) => {
        const p = playersIn(rows).find((x) => x.sender === jid);
        return p ? displayName(ctx.group, jid, p.name) : jid;
      };
      const top = (m: Map<string, number>) =>
        [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      const mostWins = top(wins);
      const mostPlayed = top(playedCount);
      return {
        windowDays: days,
        bestScore: best ? { score: best.score, player: nameOf(best), date: dateForDayNumber(best.dayNumber) } : null,
        mostPodiumWins: mostWins ? { player: label(mostWins[0]), wins: mostWins[1] } : null,
        mostDaysPlayed: mostPlayed ? { player: label(mostPlayed[0]), days: mostPlayed[1] } : null,
        playersSeen: playedCount.size,
      };
    },
    async remember(args) {
      if (typeof args.fact !== 'string') return { saved: false, reason: 'fact must be a string' };
      const current = await ctx.memory.get(ctx.group.id, ctx.sender);
      const next = withFact(current, args.fact, ctx.now());
      if (!next) return { saved: false, reason: 'empty or too long' };
      await ctx.memory.put(ctx.group.id, ctx.sender, next);
      return { saved: true, facts: next.facts.length };
    },
  };

  return {
    definitions: TOOL_DEFINITIONS,
    async run(name, args) {
      const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
      if (!handler) return { error: `unknown tool ${name}` };
      const object = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
      return handler(object);
    },
  };
}
