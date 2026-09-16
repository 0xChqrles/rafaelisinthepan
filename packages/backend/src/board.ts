// The #190 leaderboard reads on the ONE handler: `/board`, addressed per (day, lang) like
// everything else.
//
//   GET  /board?lang=&date=[&id=<publicId>] — the GLOBAL top 50, anonymous: the
//     population is public by design (and untrusted by design, #187 — nothing treats it
//     as truth). `id` is the caller's PUBLIC id — never the device token, so it may
//     travel in the query — and widens the answer with their own below-the-cut window.
//     A DELIBERATE exposure to know about: nothing binds `id` to the caller, so anyone
//     holding a publicId can read that player's window (score + rank + profile) for any
//     served day. Consistent with the design: publicIds are public (every signed share and
//     every board row carries one) — the trusted surface stays the POST.
//   POST /board  (+ the same query) — a GROUP's boards (#271), the trusted surface: the
//     server resolves the account the caller's DEVICE TOKEN (#216) maps to and answers
//     only for a group that account is IN — the token authenticates in the BODY.
//       { token, group }                   — the group's DAY board (the shared `Board`);
//       { token, group, period: 'week' | 'month' }
//                                          — its WEEK or MONTH (`PeriodBoard`), ranked by
//                                            the shared period rule (`rankPeriod`);
//       { token, standing: true }          — where the caller stands today in each of
//                                            their groups (`GroupStanding[]`), the solved
//                                            screen's one line.
//
// Every answer is rows a board can draw directly: rank (competition ties), score, and the
// public profile (#188) — name and avatar — attached per row. The ranking, the plain
// top-50 cut, the own-row window and the period rule are the shared pure rules in
// @whippin/shared/leaderboard.ts.
//
// A GROUP'S DAY BOARD IS ALIVE MID-DAY (#206): a member with a stored round but no
// recorded score is IN PROGRESS, not "not played yet" — their row carries the EXACT
// deduped try count and the server-derived reconstruction percentage, ordered among
// themselves below every finished row. Members only, never the global board (a membership
// is consented by construction; strangers watching you play is not the same thing), and
// it leaks nothing about the puzzle — a percentage and a try count say nothing about
// which words are involved. Getting the try count EXACT needs the day's FULL artifact
// (`countTries` dedups on a guess's rank in EVERY map, which no summary answers — the raw
// stored log can hold one identity twice whenever two devices merge), so the day POST is
// the one board read that touches the puzzle store, read FRESH like every other artifact
// read (#203's rule, puzzleReads.ts).
//
// The GLOBAL GET, the period boards and the standing read no puzzle store: a population
// only ever exists for a published daily (the round route's guards enforce it — it is
// what writes the score rows since #203), so an unpublished day honestly answers empty.
// The malformed-param 400s and the future +1-day guard still apply (shared liveRoute.ts).

import {
  boardOwnRows,
  countTries,
  cutBoard,
  isBoardPeriod,
  orderPlaying,
  periodRange,
  rankBoard,
  rankPeriod,
  standingIn,
  GROUP_ID_PATTERN,
  PUBLIC_ID_PATTERN,
  type Board,
  type BoardPlayer,
  type BoardRow,
  type GroupStanding,
  type PeriodBoard,
  type PeriodDay,
  type PeriodRow,
  type PlayingRow,
  type PlayingScore,
  type RankedScore,
} from '@whippin/shared';
import type { DeviceStore } from './deviceStore';
import type { GroupStore } from './groupStore';
import { LIVE_HEADERS, readJsonObject, requireDayParams, requireDevice } from './liveRoute';
import type { ProfileStore } from './profileStore';
import type { RoundKey, RoundStore } from './roundStore';
import type { ScoreKey, ScoreStore } from './scoreStore';
import type { PuzzleStore } from './store';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

export interface BoardHandlerDeps {
  scores: ScoreStore;
  profiles: ProfileStore;
  // The trusted boards are drawn over a group's member list (#271).
  groups: GroupStore;
  // The trusted face authenticates its caller's device (#216); the anonymous GET does not.
  devices: DeviceStore;
  // The #206 in-progress rows: the members' stored rounds, and the day's full artifact
  // the exact try count dedups their logs against. Optional for the read-only handler
  // consumers that never take the day POST; without both, the board simply carries no
  // playing section — production and the local server always provide them.
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

// Whether a row may be RENDERED AT ALL (#204). An email link can delete the account a
// device leaves, and an identity-bearing read must stop exposing it the moment its row is
// gone — including through the assigned fallback, which is still that player's pseudonym
// and mark. The orphan's SCORE may linger in the anonymous `/scores` histogram until the
// housekeeping sweep collects it (that read renders no identity); a board may not.
//
// A read that FAILED is NOT a deletion: it dresses blank and stays, exactly as before.
type Live = (publicId: string) => boolean;

// Dress ranked rows with the public profile a board renders. One read per DISTINCT
// player (a row and the own window can overlap populations, never within themselves),
// in parallel — the response is bounded (top 50 + a 5-row window, or GROUP_MEMBERS_MAX
// rows).
// Per-id `catch`, never `Promise.all`'s fail-fast: one throttled GetItem must not 500 a
// board whose every score row and edge already answered.
async function dressRows(
  profiles: ProfileStore,
  ...sections: (readonly { publicId: string }[])[]
): Promise<{ dress: Dress; live: Live }> {
  const ids = [...new Set(sections.flat().map((row) => row.publicId))];
  const records = await Promise.all(ids.map((id) => profiles.get(id).catch(() => null)));
  const byId = new Map(
    ids.map((id, i) => [
      id,
      // `|| null` on the avatar: an empty stored string must dress as "no mark" — the
      // client renders the assigned mark for null, where '' is not a decodable avatar.
      {
        name: records[i]?.profile?.name ?? '',
        avatar: records[i]?.profile?.avatar || null,
        // A FAILED read (null) is not evidence of a deleted account, so it stays live: the
        // rule is "stop exposing a player who is gone", never "hide a player whose
        // decoration could not be read".
        live: records[i] === null || records[i]!.live,
      },
    ]),
  );
  return {
    // The row's DECORATION only — `live` is a separate question and must never leak into the
    // JSON a board row is spread into.
    dress: (publicId) => {
      const found = byId.get(publicId);
      return found ? { name: found.name, avatar: found.avatar } : NO_PROFILE;
    },
    live: (publicId) => byId.get(publicId)?.live ?? true,
  };
}

function toBoardRows(rows: readonly RankedScore[], dress: Dress): BoardRow[] {
  return rows.map((row) => ({ ...row, ...dress(row.publicId) }));
}

// The #206 in-progress candidates: every group member's stored round for this daily,
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
// the waiting section claim "not played yet" over a member mid-game — a claim, and a
// false one — where a failed board keeps the client's cached rows on screen instead.
// An UNPUBLISHED day is not a failure: no artifact means no round route ever accepted
// a guess for it, so the empty list is the honest answer.
async function loadPlaying(
  rounds: RoundStore | undefined,
  puzzles: PuzzleStore | undefined,
  key: RoundKey,
  members: readonly string[],
): Promise<PlayingScore[]> {
  if (!rounds || !puzzles) return [];
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

  // The same protocol guards as /scores: a supported language and a real date no further
  // than one day ahead of the server's own active day.
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
    const ranked = rankBoard(await deps.scores.list(key));
    const cut = cutBoard(ranked);
    const own = id === undefined ? null : boardOwnRows(ranked, cut, id);
    const { dress, live } = await dressRows(deps.profiles, cut, own ?? []);
    // A row whose ACCOUNT is gone is DROPPED rather than dressed (#204). It leaves a gap in
    // the visible rank sequence, which is the honest picture — somebody left — and the
    // alternative is worse: the client's fallback for a blank row is that player's own
    // assigned pseudonym and mark, so dressing it would keep rendering the identity the
    // link deleted. Filtering AFTER the cut is deliberate: the check is one read per row
    // SHOWN, and testing the whole day partition would be a lookup per player who played.
    const board: Board = {
      rows: toBoardRows(cut, dress).filter((row) => live(row.publicId)),
      own: own === null ? null : toBoardRows(own, dress).filter((row) => live(row.publicId)),
      playing: [],
      waiting: [],
    };
    return json(200, board, responseHeaders);
  }

  // POST — a group's boards. The body carries the proof of identity and which group.
  const body = readJsonObject(event, 'Board', responseHeaders);
  if (!body.ok) return body.response;
  const auth = await requireDevice(body.value, responseHeaders, deps.devices, instant);
  if (!auth.ok) return auth.response;
  const publicId = auth.value.account.accountId;
  const { group, period = 'day', standing } = body.value;

  if (standing !== undefined) {
    if (standing !== true || group !== undefined || body.value.period !== undefined) {
      return errorResponse(
        400,
        'bad_request',
        'Body field "standing" must be true, and asks for no group or period.',
        responseHeaders,
      );
    }
    return json(200, { standings: await readStandings(deps, key, publicId) }, responseHeaders);
  }

  if (typeof group !== 'string' || !GROUP_ID_PATTERN.test(group)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "group" must be a 16-character group id.',
      responseHeaders,
    );
  }
  if (!isBoardPeriod(period)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "period" must be "day", "week" or "month" when present.',
      responseHeaders,
    );
  }

  // The trust boundary (#271): a board is drawn over a group's member list, and only for
  // a caller ON it — "nothing reads across players outside a group's member list". A group
  // that does not exist has no members, so it answers the same refusal: this device holds
  // a group id its account is not in (removed, left on another device), and the client's
  // move is the same either way — re-read its groups.
  const members = (await deps.groups.members(group)).map((member) => member.publicId);
  if (!members.includes(publicId)) {
    return errorResponse(403, 'not_member', 'You are not in this group.', responseHeaders);
  }

  if (period !== 'day') {
    return json(200, await readPeriodBoard(deps, key, period, members), responseHeaders);
  }

  // The DAY board: the members — the caller included — hold the exact row keys, so BOTH
  // stores fetch THOSE (batch-shaped, constant in the day's population) rather than paging
  // anything. Recorded scores make the RANKED rows. A member with a stored round but no
  // score is IN PROGRESS (#206), with the exact try count and percentage — the caller
  // included: on a group of more than one, their own live row shows where they stand
  // mid-day (the web keeps a group of one as its empty ghost). A member with neither is
  // still named, in `waiting` — a member is a person in a group the caller chose, so the
  // board says "not played yet" rather than silently dropping them (user-decided
  // 2026-08-20); the caller's own unplayed row stays absent (the header's own face already
  // shows them). Bounded by GROUP_MEMBERS_MAX, so no cut.
  const others = members.filter((id) => id !== publicId);
  const [rows, candidates] = await Promise.all([
    deps.scores.getMany(key, members),
    loadPlaying(deps.rounds, deps.puzzles, key, members),
  ]);
  const ranked = rankBoard(rows);
  const scored = new Set(rows.map((row) => row.publicId));
  // A member the population already ranks is FINISHED, whatever their round row says —
  // the recorded score is the day's final word on them.
  //
  // What this subtracts is the RANKED, which is not the DONE (user-decided 2026-08-26, on
  // review — the reasoning is in the root AGENTS.md #206 section, the fourth state is
  // #224). A capped round ends at infinity and records no row (#214), a solve past the
  // 22:00 flip is late and earns none (#211's `onTime`), and one whose row the #169 IP
  // allowance refused records none either — all three keep their derived summary here and
  // read as IN PROGRESS for the rest of the day. ACCEPTED: the numbers on the row are the
  // player's real ones and only the caption over-claims, where the cheap fix would file a
  // 500-guess round or an actual solve under "not played yet" — the false claim this whole
  // section exists to refuse.
  const playing = orderPlaying(candidates.filter((row) => !scored.has(row.publicId)));
  const playingIds = new Set(playing.map((row) => row.publicId));
  // Sorted for a stable board between reads; publicId is the only order every waiting
  // row is guaranteed to carry.
  const waiting = others.filter((id) => !scored.has(id) && !playingIds.has(id)).sort();
  const { dress, live } = await dressRows(
    deps.profiles,
    ranked,
    playing,
    waiting.map((id) => ({ publicId: id })),
  );
  // The same #204 rule on every section. A member whose account was deleted by their own
  // email link disappears from this board at once, and from the group itself when the
  // link's departure drains. What it will never do is render a deleted identity.
  const board: Board = {
    rows: toBoardRows(ranked, dress).filter((row) => live(row.publicId)),
    own: null,
    playing: playing
      .filter((row) => live(row.publicId))
      .map((row): PlayingRow => ({ ...row, ...dress(row.publicId) })),
    waiting: waiting
      .filter((id) => live(id))
      .map((id): BoardPlayer => ({ publicId: id, ...dress(id) })),
  };
  return json(200, board, responseHeaders);
}

// A group's WEEK or MONTH (#271): every member's recorded score on every day of the range,
// ranked by the ONE shared period rule. The score rows live in DAY partitions, so the read
// is the day board's own exact-key batch, once per day of the range (at most 31 × the
// member list), concurrently — no new store and no new write: a member's day counts
// exactly when the day board ranked them (#211's on-time rule already decided which rows
// exist). The period boards read no puzzle and no round: they rank what is FINISHED.
async function readPeriodBoard(
  deps: BoardHandlerDeps,
  key: ScoreKey,
  period: 'week' | 'month',
  members: readonly string[],
): Promise<PeriodBoard> {
  const dates = periodRange(period, key.date);
  const perDay = await Promise.all(
    dates.map((date) => deps.scores.getMany({ ...key, date }, members)),
  );
  const days: PeriodDay[] = perDay.flatMap((rows, i) =>
    rows.map((row) => ({ ...row, date: dates[i] })),
  );
  const ranked = rankPeriod(days);
  const { dress, live } = await dressRows(deps.profiles, ranked);
  return {
    from: dates[0],
    to: dates[dates.length - 1],
    rows: ranked
      .filter((row) => live(row.publicId))
      .map((row): PeriodRow => ({ ...row, ...dress(row.publicId) })),
  };
}

// Where the caller stands TODAY in each of their groups (#271) — the solved screen's one
// line, and the reason it needs ONE request rather than a board per group: every group's
// member list (GROUPS_MAX Queries at most), then ONE exact-key batch over the union of
// members for the day, ranked per group by the day board's own rule. Score rows only —
// no artifact, no rounds, no profiles — which is what keeps a solve's standing cheap.
//
// A member whose account an email link deleted is still in a member list until that
// link's departure drains (normally the same request), and in that window their row
// counts here where the board would drop it: accepted, since it is milliseconds and no
// face is rendered from this answer.
async function readStandings(
  deps: BoardHandlerDeps,
  key: ScoreKey,
  publicId: string,
): Promise<GroupStanding[]> {
  const mine = await deps.groups.listMine(publicId);
  if (mine.length === 0) return [];
  const lists = await Promise.all(mine.map((group) => deps.groups.members(group.id)));
  const union = [...new Set(lists.flat().map((member) => member.publicId))];
  const rows = await deps.scores.getMany(key, union);
  const byId = new Map(rows.map((row) => [row.publicId, row]));
  return mine.flatMap((group, i): GroupStanding[] => {
    const groupRows = lists[i].flatMap((member) => {
      const row = byId.get(member.publicId);
      return row ? [row] : [];
    });
    const standing = standingIn(rankBoard(groupRows), publicId);
    return standing ? [{ group: group.id, ...standing }] : [];
  });
}
