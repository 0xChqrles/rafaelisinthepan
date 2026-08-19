// The #190 leaderboard reads on the ONE handler: `/board`, addressed per (day, lang,
// mode) like everything else, answering the shared `Board` shape both tabs render.
//
//   GET  /board?lang=&date=&mode=[&id=<publicId>] — the GLOBAL top 50, anonymous: the
//     population is public by design (and untrusted by design, #187 — nothing treats it
//     as truth). `id` is the caller's PUBLIC id — never the secret, so it may travel in
//     the query — and only widens the answer with their own below-the-cut window.
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
// malformed-param 400s and the future +1-day guard still apply.

import {
  boardOwnRows,
  cutBoard,
  dayNumber,
  isValidSecret,
  publicIdFromSecret,
  rankBoard,
  PUBLIC_ID_PATTERN,
  type Board,
  type BoardPlayer,
  type BoardRow,
  type RankedScore,
} from '@whippin/shared';
import type { FriendStore } from './friendStore';
import { isValidDate } from './layout';
import type { ProfileStore } from './profileStore';
import { SENTENCE_SCORE_MAX_BY_LANG } from './scoreLimits';
import type { ScoreKey, ScoreStore } from './scoreStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

const DATE_SKEW_DAYS = 1;
const BOARD_BODY_MAX_BYTES = 4_096;
const LIVE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export interface BoardHandlerDeps {
  scores: ScoreStore;
  profiles: ProfileStore;
  friends: FriendStore;
}

function bodyOf(event: FnUrlEvent): unknown {
  if (event.body == null) return null;
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (Buffer.byteLength(body) > BOARD_BODY_MAX_BYTES) throw new Error('request_too_large');
  return JSON.parse(body) as unknown;
}

// Dress ranked rows with the public profile a board renders. One read per DISTINCT
// player (a row and the own window can overlap populations, never within themselves),
// in parallel — the response is bounded (top 50 + a 5-row window, or FRIENDS_MAX rows).
async function dressRows(
  profiles: ProfileStore,
  ...sections: (readonly { publicId: string }[])[]
): Promise<Map<string, { name: string; avatar: string | null }>> {
  const ids = [...new Set(sections.flat().map((row) => row.publicId))];
  const records = await Promise.all(ids.map((id) => profiles.get(id)));
  return new Map(
    ids.map((id, i) => [
      id,
      { name: records[i]?.name ?? '', avatar: records[i]?.avatar ?? null },
    ]),
  );
}

function toBoardRows(
  rows: readonly RankedScore[],
  dress: Map<string, { name: string; avatar: string | null }>,
): BoardRow[] {
  return rows.map((row) => ({ ...row, ...(dress.get(row.publicId) ?? { name: '', avatar: null }) }));
}

export async function handleBoard(
  event: FnUrlEvent,
  deps: BoardHandlerDeps,
  serverDate: string,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';

  // The same protocol guards as /scores: a supported language, an explicit mode, a real
  // date no further than one day ahead of the server's own active day.
  const lang = event.queryStringParameters?.lang;
  if (!lang || SENTENCE_SCORE_MAX_BY_LANG[lang] === undefined) {
    return errorResponse(
      400,
      'bad_request',
      'Query parameter "lang" must be a supported language ("en" or "fr").',
      responseHeaders,
    );
  }
  const mode = event.queryStringParameters?.mode;
  if (mode !== 'sentence' && mode !== 'word') {
    return errorResponse(
      400,
      'bad_request',
      'Query parameter "mode" is required and must be "sentence" or "word".',
      responseHeaders,
    );
  }
  const date = event.queryStringParameters?.date;
  if (!date || !isValidDate(date)) {
    return errorResponse(
      400,
      'bad_request',
      'Query parameter "date" is required (the game day, "YYYY-MM-DD").',
      responseHeaders,
    );
  }
  if (dayNumber(date) - dayNumber(serverDate) > DATE_SKEW_DAYS) {
    return errorResponse(
      404,
      'not_found',
      `"${date}" is not released yet (active day: ${serverDate}).`,
      responseHeaders,
      { date, lang },
    );
  }

  const key: ScoreKey = { date, lang, mode };

  if (method === 'GET') {
    // The global board. `id` is optional and PUBLIC — a malformed one is a protocol
    // violation, not a missing parameter.
    const id = event.queryStringParameters?.id;
    if (id !== undefined && !PUBLIC_ID_PATTERN.test(id)) {
      return errorResponse(
        400,
        'bad_request',
        'Query parameter "id" must be a 16-character player id when present.',
        responseHeaders,
      );
    }
    const ranked = rankBoard(await deps.scores.list(key), mode);
    const cut = cutBoard(ranked);
    const own = id === undefined ? null : boardOwnRows(ranked, cut, id);
    const dress = await dressRows(deps.profiles, cut, own ?? []);
    const board: Board = {
      total: ranked.length,
      rows: toBoardRows(cut, dress),
      own: own === null ? null : toBoardRows(own, dress),
      waiting: [],
    };
    return json(200, board, responseHeaders);
  }

  // POST — the friends board. The body carries only the proof of identity.
  let raw: unknown;
  try {
    raw = bodyOf(event);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'request_too_large';
    return errorResponse(
      tooLarge ? 413 : 400,
      tooLarge ? 'payload_too_large' : 'bad_request',
      tooLarge ? 'Board request body is too large.' : 'Body must be valid JSON.',
      responseHeaders,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return errorResponse(400, 'bad_request', 'Body must be an object.', responseHeaders);
  }
  const body = raw as Record<string, unknown>;
  if (!isValidSecret(body.secret)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "secret" must be the 32-hex-character player key.',
      responseHeaders,
    );
  }

  const publicId = await publicIdFromSecret(body.secret);
  const friends = await deps.friends.list(publicId);
  const wanted = new Set(friends);
  wanted.add(publicId);
  // The trusted board is the caller's edges plus themselves. Recorded scores make the
  // RANKED rows; a FRIEND with no score today is still named, in `waiting` — an edge is
  // a person the caller chose, so the board says "not played yet" rather than silently
  // dropping them (user-decided 2026-08-20). The caller's own unplayed row stays absent
  // (the screen's identity strip already shows them). Bounded by FRIENDS_MAX, so no cut.
  const rows = (await deps.scores.list(key)).filter((row) => wanted.has(row.publicId));
  const ranked = rankBoard(rows, mode);
  const scored = new Set(rows.map((row) => row.publicId));
  // Sorted for a stable board between reads; publicId is the only order every waiting
  // row is guaranteed to carry.
  const waiting = friends.filter((id) => !scored.has(id)).sort();
  const dress = await dressRows(deps.profiles, ranked, waiting.map((id) => ({ publicId: id })));
  const board: Board = {
    total: ranked.length,
    rows: toBoardRows(ranked, dress),
    own: null,
    waiting: waiting.map(
      (id): BoardPlayer => ({ publicId: id, ...(dress.get(id) ?? { name: '', avatar: null }) }),
    ),
  };
  return json(200, board, responseHeaders);
}
