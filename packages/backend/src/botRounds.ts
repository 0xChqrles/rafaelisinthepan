// THE BOT'S READ OF A WHIPPIN GROUP'S ROUNDS (user-decided 2026-10-30; the wire is
// `@whippin/shared`'s `botRounds.ts`): what `BotRoundsFn` (`botRoundsWorker.ts`) answers the
// WhatsApp bot for ONE group and one daily — every member's round as it stands, and the
// guesses that never came closer than their hole's start word.
//
// Reached by IAM alone: the bot task invokes the function by name, so nothing here is a
// route, nothing is behind CloudFront and nothing authenticates a device. The CONSENT is the
// group itself — the one a bot config names — so the read is MEMBERS ONLY by construction:
// the round rows fetched are exactly the members the group's public face lists (a gone
// account already dropped, `readGroupFace`), never a wider population.
//
// THE SPOILER RULE lives here, because only the server holds the rank maps: a guess leaves
// only when, for EVERY secret, the day's map either does not rank it or ranks it STRICTLY
// FARTHER than that secret's start word. A guess at or inside any hole's `start_rank` moved
// that hole on the player's board (rank 0 is the secret itself), so naming it in a chat
// would hand the group a word closer than anything the start words already show — on any
// day, today's or the archive's, since a member may still be playing a past day.
//
// The reads mirror the board's (`board.ts` `loadPlaying`): the CURRENT published artifact
// (a fresh slice names its revision, the full artifact comes through the revision-keyed
// memory, `puzzleReads.ts`) and the members' round rows, CONCURRENTLY. Only rows naming that
// revision count — a retired revision's log answers another puzzle's maps and restarts on
// its player's next append, so for THIS puzzle they have not started.

import {
  activeDate,
  anonName,
  countTries,
  guessKey,
  isCalendarDate,
  roundEnded,
  GROUP_ID_PATTERN,
  VOCAB_BUILDS,
  type BotGuess,
  type BotMemberRound,
  type BotRoundsRequest,
  type BotRoundsResponse,
  type Puzzle,
} from '@whippin/shared';
import { readGroupFace } from './groups';
import type { GroupStore } from './groupStore';
import type { ProfileStore } from './profileStore';
import { loadCurrentPuzzle } from './puzzleReads';
import type { RoundBoardRow, RoundStore } from './roundStore';
import type { PuzzleStore } from './store';

export interface BotRoundsDeps {
  groups: GroupStore;
  profiles: ProfileStore;
  rounds: RoundStore;
  puzzles: PuzzleStore;
}

// The invoke payload as the bot sent it — untrusted until this says otherwise, and never a
// throw: a Lambda error reads to the bot as "unavailable", which a malformed request is not.
// The day is a real calendar date no later than the server's own active one: the bot asks
// about days people have played, and a future day has no rounds worth a read (no preview
// code reaches this function). A bonus address is no calendar date, so it falls here too.
export function parseBotRoundsRequest(event: unknown, now: Date): BotRoundsRequest | null {
  if (typeof event !== 'object' || event === null) return null;
  const { group, lang, date } = event as Record<string, unknown>;
  if (typeof group !== 'string' || !GROUP_ID_PATTERN.test(group)) return null;
  // `Object.hasOwn`, never an index read — the prototype chain's keys are no languages
  // (`liveRoute.ts` `requireLangParams`).
  if (typeof lang !== 'string' || !Object.hasOwn(VOCAB_BUILDS, lang)) return null;
  if (typeof date !== 'string' || !isCalendarDate(date) || date > activeDate(now)) return null;
  return { group, lang, date };
}

// Each secret's start rank, keyed by secret SLUG (the rank map's own key). A secret that
// appears twice is two holes sharing one start hint; the smaller value is kept anyway, so a
// malformed artifact can only make the rule STRICTER.
function startRanks(puzzle: Puzzle): Map<string, number> {
  const starts = new Map<string, number>();
  for (const hole of puzzle.holes) {
    const slug = hole.secret.slug;
    starts.set(slug, Math.min(starts.get(slug) ?? Infinity, hole.start_rank));
  }
  return starts;
}

// How close a guess may rank and still leave: a start word sits around rank 100–200, and a
// guess a few hundred ranks from a secret already gives it away.
export const FAR_RANK_MIN = 1000;

// THE SPOILER RULE over one round's raw log: every UNIQUE try (the `countTries` dedup —
// `try` is the number the player saw), kept only when no map ranks it at or inside
// `FAR_RANK_MIN` (or its secret's start, were that farther), and handed back ODDEST FIRST (misses, then farthest; the contract's
// order) with no rank: the rank orders, the word is what leaves. A map with no start rank to compare against (no hole
// names that secret — never in a published artifact) treats every ranked word as near: the
// rule fails closed.
export function farGuesses(puzzle: Puzzle, log: readonly string[]): BotGuess[] {
  const starts = startRanks(puzzle);
  const secrets = Object.keys(puzzle.ranks);
  const seen = new Set<string>();
  const far: (BotGuess & { rank: number | null })[] = [];
  for (const typed of log) {
    const key = guessKey(puzzle.ranks, typed);
    if (seen.has(key)) continue;
    seen.add(key);
    let closest: { word: string; rank: number } | null = null;
    let near = false;
    for (const secret of secrets) {
      // OWN keys only: a guess is any string `fold()` leaves alone, `constructor` included.
      const map = puzzle.ranks[secret];
      const entry = Object.hasOwn(map, typed) ? map[typed] : undefined;
      if (!entry) continue;
      if (entry.rank <= Math.max(FAR_RANK_MIN, starts.get(secret) ?? Infinity)) {
        near = true;
        break;
      }
      if (!closest || entry.rank < closest.rank) closest = entry;
    }
    if (near) continue;
    far.push({
      try: seen.size,
      // The closest group's DISPLAY form; a miss keeps the folded string the log stores.
      word: closest ? closest.word : typed,
      rank: closest ? closest.rank : null,
    });
  }
  far.sort((a, b) => {
    if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? -1 : 1;
    return (b.rank ?? 0) - (a.rank ?? 0) || a.try - b.try;
  });
  return far.map(({ try: at, word }) => ({ try: at, word }));
}

function notStarted(publicId: string, name: string): BotMemberRound {
  return {
    publicId,
    name,
    started: false,
    tries: 0,
    progress: 0,
    solved: false,
    gaveUp: false,
    over: false,
    farGuesses: [],
  };
}

function memberRound(publicId: string, name: string, puzzle: Puzzle, row: RoundBoardRow | undefined): BotMemberRound {
  if (!row || row.puzzle !== puzzle.revision || row.guesses.length === 0) return notStarted(publicId, name);
  return {
    publicId,
    name,
    started: true,
    tries: countTries(puzzle.ranks, row.guesses),
    // The stored derived percentage (#203) — the board's and the calendar's own number.
    progress: row.progress,
    solved: row.solved,
    gaveUp: row.gaveUp,
    over: roundEnded(row),
    farGuesses: farGuesses(puzzle, row.guesses),
  };
}

// The whole read. Store failures PROPAGATE (the entry lets the Lambda fail, the bot reads
// "unavailable"): a degraded answer would claim members have not started when they have.
export async function readBotRounds(
  deps: BotRoundsDeps,
  event: unknown,
  now: Date = new Date(),
): Promise<BotRoundsResponse> {
  const request = parseBotRoundsRequest(event, now);
  if (!request) return { ok: false, error: 'bad_request' };
  const { group, lang, date } = request;
  // The artifact does not depend on the group: started now, it overlaps the face read and
  // the round batch below.
  const puzzleRead = loadCurrentPuzzle(deps.puzzles, date, lang);
  // Never left unobserved if the face read throws first: the face's error is the one thrown.
  puzzleRead.catch(() => undefined);
  const face = await readGroupFace(deps.groups, deps.profiles, group);
  if (!face) return { ok: false, error: 'unknown_group' };
  const ids = face.members.map((member) => member.publicId);
  const [puzzle, rows] = await Promise.all([
    puzzleRead,
    ids.length > 0 ? deps.rounds.getMany({ date, lang }, ids) : Promise.resolve([]),
  ]);
  const byId = new Map(rows.map((row) => [row.publicId, row]));
  // The profile name, else the assigned pseudonym every surface draws for a player who never
  // chose one (shared `assigned.ts`) — the name the group sees on its boards.
  const members = face.members.map(({ publicId, name }) => {
    const shown = name || anonName(publicId);
    return puzzle ? memberRound(publicId, shown, puzzle, byId.get(publicId)) : notStarted(publicId, shown);
  });
  return {
    ok: true,
    group: { id: face.group.id, name: face.group.name },
    revision: puzzle?.revision ?? null,
    members,
  };
}
