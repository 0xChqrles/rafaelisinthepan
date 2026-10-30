// THE WHIPPIN GROUP'S ROUNDS (user-decided 2026-10-30): every member's round of one daily as
// it stands — started or not, tries, %, solved, ended at ∞ — and the guesses that came
// nowhere near, read from the backend's `BotRoundsFn` (`shared/src/botRounds.ts`, the one
// contract between the two). The share line jokes about an odd word a player tried, and
// every conversation call carries the group's live state (`chat/liveState.ts`).
//
// CONSENT IS MEMBERSHIP OF THE WHIPPIN GROUP THE CONFIG NAMES (`GroupConfig.whippinGroup`):
// the function reads that group's members and nobody else, and a config with no such field
// reads nothing. THE SPOILER RULE IS THE SERVER'S: a guess that ever came as close as its
// hole's start word never leaves the backend, so what arrives here reveals nothing beyond
// the start words every player already sees. No rank travels: the server orders the words
// oddest first and the word is all a line needs.
//
// INVOKED OVER IAM, never fetched: the function has no route and no CDN in front of it, and
// the task's role is what grants the call (`lambda:InvokeFunction`). Built against
// `botRegion()`, like every AWS client here.
//
// CACHED PER (GROUP, LANGUAGE, DATE) FOR `LIVE_ROUNDS_TTL_MS`, IN MEMORY ONLY. A busy group
// talks several times a minute and every one of those messages carries the live state, and
// a minute-old % is still the state of the game for a conversation. Concurrent askers share
// ONE flight. A FRESH read skips the held answer (a share is posted the moment its round
// ends, often inside the minute a chat message cached the round still in play) and refills
// it, so the next conversation call sees the solve too. Nothing read here is ever written down (the privacy notice: "about a minute").
//
// IT NEVER FAILS ANYBODY: a refused invoke, a function error, a timeout and an answer that
// does not parse all answer null — no line about the guesses, no live state — and are
// logged by kind. No log line carries a guess, a name or the Whippin group's id (an invite
// link is a way in).

import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import {
  GROUP_ID_PATTERN,
  PUBLIC_ID_PATTERN,
  type BotGuess,
  type BotMemberRound,
  type BotRoundsRequest,
} from '@whippin/shared';
import type { Log } from '../log';

export const LIVE_ROUNDS_TTL_MS = 60_000;
// The invoke's own bound. The callers bound their WAIT harder (`chat/liveState.ts`), and a
// slow flight still fills the cache for the next one.
const INVOKE_TIMEOUT_MS = 10_000;

export interface GroupRounds {
  group: { id: string; name: string };
  revision: string | null;
  members: BotMemberRound[];
}

export interface GroupRoundsReader {
  // The group's rounds of that daily, or null when they could not be read.
  read(group: string, lang: string, date: string, options?: { fresh?: boolean }): Promise<GroupRounds | null>;
}

// One call to the function, answering its payload as parsed JSON. Injected, so the cache,
// the flight and the validation are tested without AWS.
export type InvokeRounds = (request: BotRoundsRequest) => Promise<unknown>;

export function lambdaRoundsInvoker(client: LambdaClient, functionName: string): InvokeRounds {
  return async (request) => {
    const response = await client.send(
      new InvokeCommand({ FunctionName: functionName, Payload: new TextEncoder().encode(JSON.stringify(request)) }),
      { abortSignal: AbortSignal.timeout(INVOKE_TIMEOUT_MS) },
    );
    // A function that threw still answers 200, with the error as its payload.
    if (response.FunctionError) throw new Error(`function error: ${response.FunctionError}`);
    return JSON.parse(new TextDecoder().decode(response.Payload ?? new Uint8Array()));
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function parseGuess(raw: unknown): BotGuess | null {
  if (!isRecord(raw) || !isCount(raw.try) || raw.try < 1) return null;
  if (typeof raw.word !== 'string' || raw.word.trim() === '') return null;
  return { try: raw.try, word: raw.word };
}

function parseMember(raw: unknown): BotMemberRound | null {
  if (!isRecord(raw)) return null;
  const { publicId, name, started, tries, progress, solved, gaveUp, over, farGuesses } = raw;
  if (typeof publicId !== 'string' || !PUBLIC_ID_PATTERN.test(publicId) || typeof name !== 'string') return null;
  if (typeof started !== 'boolean' || typeof solved !== 'boolean' || typeof gaveUp !== 'boolean' || typeof over !== 'boolean') return null;
  if (!isCount(tries) || typeof progress !== 'number' || !(progress >= 0 && progress <= 100)) return null;
  if (!Array.isArray(farGuesses)) return null;
  const guesses = farGuesses.map(parseGuess);
  if (guesses.some((g) => g === null)) return null;
  return { publicId, name, started, tries, progress, solved, gaveUp, over, farGuesses: guesses as BotGuess[] };
}

// THE ANSWER, OR NOTHING. Every field checked against the contract, and ONE bad member
// refuses the whole answer: a half-trusted read is how a wrong number reaches a prompt.
// An answer about another group than the one asked is no answer either.
export function parseRoundsAnswer(raw: unknown, asked: BotRoundsRequest): GroupRounds | 'refused' | null {
  if (!isRecord(raw)) return null;
  if (raw.ok === false) return 'refused';
  if (raw.ok !== true || !isRecord(raw.group) || raw.group.id !== asked.group || typeof raw.group.name !== 'string') return null;
  if (raw.revision !== null && typeof raw.revision !== 'string') return null;
  if (!Array.isArray(raw.members)) return null;
  const members = raw.members.map(parseMember);
  if (members.some((m) => m === null)) return null;
  return { group: { id: raw.group.id, name: raw.group.name }, revision: raw.revision, members: members as BotMemberRound[] };
}

export function createGroupRoundsReader(deps: { invoke: InvokeRounds; log: Log; now?: () => number; ttlMs?: number }): GroupRoundsReader {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? LIVE_ROUNDS_TTL_MS;
  // A held answer — null included, so a function that is down is asked once a minute, never
  // at the rate the group talks — or the one flight every asker of that key waits on.
  const held = new Map<string, { at: number; value: GroupRounds | null }>();
  const flights = new Map<string, Promise<GroupRounds | null>>();

  async function fetchRounds(request: BotRoundsRequest): Promise<GroupRounds | null> {
    let raw: unknown;
    try {
      raw = await deps.invoke(request);
    } catch (error) {
      deps.log.warn({ event: 'rounds.unreachable', lang: request.lang, date: request.date, error: (error as Error).message }, 'could not read the Whippin group\'s rounds');
      return null;
    }
    const parsed = parseRoundsAnswer(raw, request);
    if (parsed === 'refused') {
      const error = isRecord(raw) && typeof raw.error === 'string' ? raw.error : 'unknown';
      deps.log.warn({ event: 'rounds.refused', error, lang: request.lang, date: request.date }, 'the rounds read was refused');
      return null;
    }
    if (!parsed) {
      deps.log.warn({ event: 'rounds.unparseable', lang: request.lang, date: request.date }, 'the rounds answer did not parse');
      return null;
    }
    deps.log.info({ event: 'rounds.read', lang: request.lang, date: request.date, members: parsed.members.length }, 'rounds read');
    return parsed;
  }

  return {
    async read(group, lang, date, options) {
      // Checked here too, so no caller can send the function something it must refuse.
      if (!GROUP_ID_PATTERN.test(group)) return null;
      const key = `${group}#${lang}#${date}`;
      const hit = held.get(key);
      if (!options?.fresh && hit && now() - hit.at < ttl) return hit.value;
      const flying = flights.get(key);
      if (flying && !options?.fresh) return flying;
      const flight = fetchRounds({ group, lang, date })
        .then((value) => {
          held.set(key, { at: now(), value });
          return value;
        })
        .finally(() => {
          if (flights.get(key) === flight) flights.delete(key);
        });
      flights.set(key, flight);
      return flight;
    },
  };
}

// THE WORDS WORTH A LOOK, at most `max`: the first of the server's order (oddest first:
// misses, then the farthest) — handed back in play order, each with its try number, so
// "your 4th try" is what the player saw.
export function oddGuesses(guesses: readonly BotGuess[], max: number): BotGuess[] {
  return guesses.slice(0, max).sort((a, b) => a.try - b.try);
}

// How many of a player's far words a comment's facts carry.
export const TRIED_WORDS_MAX = 12;

// A player's far words as a comment's facts carry them (the share line, the podium), with
// how to read them. Neutral key names, since the writer borrows the vocabulary it is shown.
// Empty when there is nothing to carry.
export function triedWordsFacts(guesses: readonly BotGuess[]) {
  const picked = oddGuesses(guesses, TRIED_WORDS_MAX);
  if (picked.length === 0) return {};
  return {
    triedWords: picked.map((g) => ({ try: g.try, word: g.word })),
    triedWordsReading: `"triedWords" are words this player tried today that came nowhere near any hidden word ("try" is which of their tries it was). A word may have lost its accents. They say nothing about the answer.`,
  };
}

// THE WORDS THEY TRIED (user-decided 2026-10-30), the comment tasks' one rule about them:
// one odd word is the joke a friend makes, the answer is never touched.
export const TRIED_WORDS_RULE = `If the facts carry "triedWords", you may joke about ONE odd word this player tried when it is actually funny, and leave them out otherwise. Never a word that is not in "triedWords", and never a guess or a hint at the hidden words.`;

// A read the caller will not wait on past `ms`: null then, while the flight carries on (and
// still fills the cache for the next asker).
export function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer));
}
