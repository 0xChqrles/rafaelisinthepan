// The #190 leaderboard reads on the ONE handler: `/board`, addressed per (day, lang,
// mode) like everything else, answering the shared `Board` shape both tabs render.
//
//   GET  /board?lang=&date=&mode=[&id=<publicId>] — the GLOBAL top 50, anonymous: the
//     population is public by design (and untrusted by design, #187 — nothing treats it
//     as truth). `id` is the caller's PUBLIC id — never the secret, so it may travel in
//     the query — and widens the answer with their own below-the-cut window.
//     A DELIBERATE exposure to know about: nothing binds `id` to the caller, so anyone
//     holding a publicId can read that player's window (score + rank + profile) for any
//     served day. Consistent with the design: publicIds are broadcast by invite links
//     (#189), and a stranger holding your id could already read your scores by
//     friending you through that same link — the trusted surface stays the POST.
//   POST /board  { secret }  (+ the same query) — the FRIENDS board, the trusted
//     surface: the server resolves YOUR edges (#189), so the read must prove who is
//     asking — the secret authenticates in the BODY, the /friends rule.
//
// Both answers are rows a board can draw directly: rank (competition ties), score, and
// the public profile (#188) — name and avatar — attached per row. The ranking, the
// plain top-50 cut and the own-row window are the shared pure rules in
// @whippin/shared/leaderboard.ts.
//
// No puzzle-store read: a population only ever exists for a published daily (the score
// POST enforces it), so an unpublished day honestly answers the empty board. The
// malformed-param 400s and the future +1-day guard still apply (shared liveRoute.ts).

import {
  boardOwnRows,
  cutBoard,
  rankBoard,
  PUBLIC_ID_PATTERN,
  type Board,
  type BoardPlayer,
  type BoardRow,
  type RankedScore,
} from '@whippin/shared';
import type { DeviceStore } from './deviceStore';
import type { FriendStore } from './friendStore';
import { LIVE_HEADERS, readJsonObject, requireDayParams, requireDevice } from './liveRoute';
import type { ProfileStore } from './profileStore';
import type { ScoreKey, ScoreStore } from './scoreStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

export interface BoardHandlerDeps {
  scores: ScoreStore;
  profiles: ProfileStore;
  friends: FriendStore;
  // The trusted face authenticates its caller's device (#216); the anonymous GET does not.
  devices: DeviceStore;
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
  // holds the exact row keys, so the store fetches THOSE (batch-shaped, constant in the
  // day's population) rather than paging the whole day partition to keep at most
  // FRIENDS_MAX + 1 rows. Recorded scores make the RANKED rows; a FRIEND with no score
  // today is still named, in `waiting` — an edge is a person the caller chose, so the
  // board says "not played yet" rather than silently dropping them (user-decided
  // 2026-08-20). The caller's own unplayed row stays absent (the screen's identity
  // strip already shows them). Bounded by FRIENDS_MAX, so no cut.
  const rows = await deps.scores.getMany(key, [...friends, publicId]);
  const ranked = rankBoard(rows, key.mode);
  const scored = new Set(rows.map((row) => row.publicId));
  // Sorted for a stable board between reads; publicId is the only order every waiting
  // row is guaranteed to carry.
  const waiting = friends.filter((id) => !scored.has(id)).sort();
  const dress = await dressRows(deps.profiles, ranked, waiting.map((id) => ({ publicId: id })));
  const board: Board = {
    rows: toBoardRows(ranked, dress),
    own: null,
    waiting: waiting.map((id): BoardPlayer => ({ publicId: id, ...dress(id) })),
  };
  return json(200, board, responseHeaders);
}
