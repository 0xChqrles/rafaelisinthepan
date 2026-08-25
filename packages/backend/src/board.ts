// The #190 leaderboard reads on the ONE handler: `/board`, addressed per (day, lang,
// mode) like everything else, answering the shared `Board` shape both tabs render.
//
//   GET  /board?lang=&date=&mode=[&id=<publicId>] — the GLOBAL top 50, anonymous: the
//     population is public by design (and untrusted by design, #187 — nothing treats it
//     as truth). `id` is the caller's PUBLIC id — never the device token, so it may
//     travel in the query — and widens the answer with their own below-the-cut window.
//     A DELIBERATE exposure to know about: nothing binds `id` to the caller, so anyone
//     holding a publicId can read that player's window (score + rank + profile) for any
//     served day. Consistent with the design: publicIds are broadcast by invite links
//     (#189), and a stranger holding your id could already read your scores by
//     friending you through that same link — the trusted surface stays the POST.
//   POST /board  { token }  (+ the same query) — the FRIENDS board, the trusted
//     surface: the server resolves the account the caller's DEVICE TOKEN (#216) maps to,
//     then their edges (#189), so the read proves who is asking — the token
//     authenticates in the BODY, the /friends rule.
//
// Both answers are rows a board can draw directly: rank (competition ties), score, and
// the public profile (#188) — name and avatar — attached per row. The ranking, the
// plain top-50 cut and the own-row window are the shared pure rules in
// @whippin/shared/leaderboard.ts.
//
// THE FRIENDS BOARD IS ALIVE MID-DAY (#206): a friend with a stored round but no
// recorded score is IN PROGRESS, not "not played yet" — their row carries the EXACT
// deduped try count and the server-derived reconstruction percentage, ordered among
// themselves below every finished row. Friends only, never the global board (mutual
// edges are consented by construction; strangers watching you play is not the same
// thing), and it leaks nothing about the puzzle — a percentage and a try count say
// nothing about which words are involved. Getting the try count EXACT needs the day's
// FULL artifact (`countTries` dedups on a guess's rank in EVERY map, which no summary
// answers — the raw stored log can hold one identity twice whenever two devices merge),
// so the friends POST is the one board read that touches the puzzle store, read FRESH
// like every other artifact read (#203's rule, puzzleReads.ts). Sentence mode only: a
// Word run's log reaches the server at submission, so mid-run there is honestly
// nothing to read.
//
// The GLOBAL GET still reads no puzzle store: a population only ever exists for a
// published daily (the round route's guards enforce it — it is what writes the score
// rows since #203), so an unpublished day honestly answers the empty board. The
// malformed-param 400s and the future +1-day guard still apply (shared liveRoute.ts).

import {
  boardOwnRows,
  countTries,
  cutBoard,
  orderPlaying,
  rankBoard,
  PUBLIC_ID_PATTERN,
  type Board,
  type BoardPlayer,
  type BoardRow,
  type PlayingRow,
  type PlayingScore,
  type RankedScore,
} from '@whippin/shared';
import type { DeviceStore } from './deviceStore';
import type { FriendStore } from './friendStore';
import { LIVE_HEADERS, readJsonObject, requireDayParams, requireDevice } from './liveRoute';
import type { ProfileStore } from './profileStore';
import type { RoundKey, RoundStore } from './roundStore';
import type { ScoreKey, ScoreStore } from './scoreStore';
import type { PuzzleStore } from './store';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

export interface BoardHandlerDeps {
  scores: ScoreStore;
  profiles: ProfileStore;
  friends: FriendStore;
  // The trusted face authenticates its caller's device (#216); the anonymous GET does not.
  devices: DeviceStore;
  // The #206 in-progress rows: the friends' stored rounds, and the day's full artifact
  // the exact try count dedups their logs against. Optional for the read-only handler
  // consumers that never take the friends POST; without both, the board simply carries
  // no playing section — production and the local server always provide them.
  rounds?: RoundStore;
  puzzles?: PuzzleStore;
}

// How a player with NO public profile is dressed — and the ONE fallback this route
// has, spelled once: a profile that does not exist, one whose read FAILED, and an id
// nothing was read for are the same answer, because the name and the mark are
// decoration and the client derives an assigned identity from the publicId for all
// three.
const NO_PROFILE = { name: '', avatar: null } as const;

type Dress = (publicId: string) => { name: string; avatar: string | null };

// Dress ranked rows with the public profile a board renders. One read per DISTINCT
// player (a row and the own window can overlap populations, never within themselves),
// in parallel — the response is bounded (top 50 + a 5-row window, or FRIENDS_MAX rows).
// Per-id `catch`, never `Promise.all`'s fail-fast: one throttled GetItem must not 500 a
// board whose every score row and edge already answered.
async function dressRows(
  profiles: ProfileStore,
  ...sections: (readonly { publicId: string }[])[]
): Promise<Dress> {
  const ids = [...new Set(sections.flat().map((row) => row.publicId))];
  const records = await Promise.all(ids.map((id) => profiles.get(id).catch(() => null)));
  const byId = new Map(
    ids.map((id, i) => [
      id,
      // `|| null` on the avatar: an empty stored string must dress as "no mark" — the
      // client renders the assigned mark for null, where '' is not a decodable avatar.
      { name: records[i]?.name ?? '', avatar: records[i]?.avatar || null },
    ]),
  );
  return (publicId) => byId.get(publicId) ?? NO_PROFILE;
}

function toBoardRows(rows: readonly RankedScore[], dress: Dress): BoardRow[] {
  return rows.map((row) => ({ ...row, ...dress(row.publicId) }));
}

// The #206 in-progress candidates: every board member's stored round for this daily,
// deduped into an exact try count against the day's full artifact. UNFILTERED — the
// caller still subtracts the players the score population already ranks, which it can
// only do once both concurrent reads have answered.
//
// The two loads run CONCURRENTLY (neither depends on the other), and the artifact is
// read FRESH (#203's rule — puzzleReads.ts holds the whole reasoning): a board open is
// a person tapping a screen, not the per-guess hot path the derivation slice exists
// for, and a warm Lambda retaining megabytes of parsed puzzle was the cost fresh reads
// were chosen to avoid. Only rounds naming the artifact's own published revision
// qualify: a retired revision's log answers a different puzzle — its tries dedup
// against maps it was never played on — and that round restarts on the player's next
// append anyway, so for THIS puzzle they honestly have not started.
//
// A failure here PROPAGATES (it is not caught into an empty list): degrading would let
// the waiting section claim "not played yet" over a friend mid-game — a claim, and a
// false one — where a failed board keeps the client's cached rows on screen instead.
// An UNPUBLISHED day is not a failure: no artifact means no round route ever accepted
// a guess for it, so the empty list is the honest answer.
async function loadPlaying(
  rounds: RoundStore | undefined,
  puzzles: PuzzleStore | undefined,
  key: RoundKey,
  members: readonly string[],
): Promise<PlayingScore[]> {
  if (key.mode !== 'sentence' || !rounds || !puzzles) return [];
  const [puzzle, stored] = await Promise.all([
    puzzles.getPuzzle(key.date, key.lang),
    rounds.getMany(key, members),
  ]);
  if (!puzzle) return [];
  return stored
    .filter((row) => row.puzzle === puzzle.revision && row.guesses.length > 0)
    .map((row) => ({
      publicId: row.publicId,
      tries: countTries(puzzle.ranks, row.guesses),
      // The stored derived percentage (#203) — the calendar's own source, so the board
      // and the archive can never disagree over one log.
      progress: row.progress,
    }));
}

export async function handleBoard(
  event: FnUrlEvent,
  deps: BoardHandlerDeps,
  serverDate: string,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';

  // The same protocol guards as /scores: a supported language, an explicit mode, a real
  // date no further than one day ahead of the server's own active day.
  const params = requireDayParams(event, serverDate, responseHeaders);
  if (!params.ok) return params.response;
  const key: ScoreKey = params.value;

  if (method === 'GET') {
    // The global board. `id` is optional and PUBLIC — a malformed one is a protocol
    // violation, not a missing parameter. (The exposure this creates is deliberate and
    // recorded in the route header above.)
    const id = event.queryStringParameters?.id;
    if (id !== undefined && !PUBLIC_ID_PATTERN.test(id)) {
      return errorResponse(
        400,
        'bad_request',
        'Query parameter "id" must be a 16-character player id when present.',
        responseHeaders,
      );
    }
    const ranked = rankBoard(await deps.scores.list(key), key.mode);
    const cut = cutBoard(ranked);
    const own = id === undefined ? null : boardOwnRows(ranked, cut, id);
    const dress = await dressRows(deps.profiles, cut, own ?? []);
    const board: Board = {
      rows: toBoardRows(cut, dress),
      own: own === null ? null : toBoardRows(own, dress),
      playing: [],
      waiting: [],
    };
    return json(200, board, responseHeaders);
  }

  // POST — the friends board. The body carries only the proof of identity.
  const body = readJsonObject(event, 'Board', responseHeaders);
  if (!body.ok) return body.response;
  const auth = await requireDevice(body.value, responseHeaders, deps.devices, instant);
  if (!auth.ok) return auth.response;

  const publicId = auth.value.account.accountId;
  const friends = await deps.friends.list(publicId);
  // The trusted board is the caller's edges plus themselves — and the caller already
  // holds the exact row keys, so BOTH stores fetch THOSE (batch-shaped, constant in the
  // day's population) rather than paging anything. Recorded scores make the RANKED
  // rows. A friend with a stored round but no score is IN PROGRESS (#206), with the
  // exact try count and percentage — the caller included: their own live row is the one
  // place they see where they stand among friends mid-day. A FRIEND with neither is
  // still named, in `waiting` — an edge is a person the caller chose, so the board says
  // "not played yet" rather than silently dropping them (user-decided 2026-08-20); the
  // caller's own unplayed row stays absent (the screen's identity strip already shows
  // them). Bounded by FRIENDS_MAX, so no cut.
  const members = [...friends, publicId];
  const [rows, candidates] = await Promise.all([
    deps.scores.getMany(key, members),
    loadPlaying(deps.rounds, deps.puzzles, key, members),
  ]);
  const ranked = rankBoard(rows, key.mode);
  const scored = new Set(rows.map((row) => row.publicId));
  // A member the population already ranks is FINISHED, whatever their round row says —
  // the recorded score is the day's final word on them.
  const playing = orderPlaying(candidates.filter((row) => !scored.has(row.publicId)));
  const playingIds = new Set(playing.map((row) => row.publicId));
  // Sorted for a stable board between reads; publicId is the only order every waiting
  // row is guaranteed to carry.
  const waiting = friends.filter((id) => !scored.has(id) && !playingIds.has(id)).sort();
  const dress = await dressRows(
    deps.profiles,
    ranked,
    playing,
    waiting.map((id) => ({ publicId: id })),
  );
  const board: Board = {
    rows: toBoardRows(ranked, dress),
    own: null,
    playing: playing.map((row): PlayingRow => ({ ...row, ...dress(row.publicId) })),
    waiting: waiting.map((id): BoardPlayer => ({ publicId: id, ...dress(id) })),
  };
  return json(200, board, responseHeaders);
}
