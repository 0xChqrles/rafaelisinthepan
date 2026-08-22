// The score route: `GET /scores?lang=&date=&mode=` — the day's anonymous population, as
// the solved screen and the post-mortem read it.
//
// IT IS READ-ONLY SINCE #203. The score used to be something the CLIENT claimed, POSTed
// with an invisible Turnstile token and validated against a per-mode ceiling. With the
// guess log server-side (#201) the server derives it instead: the round route records one
// row per player per daily the moment a round finishes (`rounds.ts`). So the POST, its
// range validation, its Turnstile gate and the whole `scoreRecorded` state machine behind
// it are retired — Turnstile moved to ROUND START, where the state is actually minted.
//
// The IP dedup did NOT retire with the POST: it is the volume floor UNDER the per-player
// rows, and it moved with the write it meters (`rounds.ts` hashes the trusted viewer
// address). `hashClientIp` stays here, beside the store contract that names the digest.

import { createHmac } from 'node:crypto';
import { PUBLIC_ID_PATTERN, type ScoreHistogram } from '@whippin/shared';
import { LIVE_HEADERS, requireDayParams } from './liveRoute';
import type { ScoreKey, ScoreRow, ScoreStore } from './scoreStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { PuzzleStore } from './store';

export interface ScoreHandlerDeps {
  scoreStore: ScoreStore;
}

export function hashClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

// The histogram is DERIVED from the day's per-player rows at read time (#187): one bucket
// per distinct recorded score, ascending, each an exact inclusive range. The rows are a
// strict superset of the retired bucket counters, so the response shape the solved screen
// consumes (#170/#176/#180) is unchanged — only the numbers' origin moved. `own` used to
// locate the caller's score on POST; with the POST retired (#203) every read is the
// anonymous one and the client locates its own count in the ranges.
export function derivedHistogram(rows: readonly ScoreRow[], own: number | null): ScoreHistogram {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.score, (counts.get(row.score) ?? 0) + 1);
  const scores = [...counts.keys()].sort((a, b) => a - b);
  const buckets = scores.map((score) => ({
    min: score,
    max: score,
    count: counts.get(score)!,
  }));
  const index = own == null ? -1 : scores.indexOf(own);
  return { buckets, total: rows.length, bucket: index < 0 ? null : index };
}

export async function handleScores(
  event: FnUrlEvent,
  puzzleStore: PuzzleStore,
  deps: ScoreHandlerDeps,
  serverDate: string,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'GET') {
    return errorResponse(
      405,
      'method_not_allowed',
      'The score route is read-only: a round records its own score when it finishes.',
      responseHeaders,
    );
  }

  // The shared (lang, mode, date) guard triple + future guard (liveRoute.ts).
  const params = requireDayParams(event, serverDate, responseHeaders);
  if (!params.ok) return params.response;
  const { lang, mode, date } = params.value;

  // The caller's PUBLIC id, never the secret — so it may travel in the query. It is what
  // makes the answer's `bucket` AUTHORITATIVE (added on review): without it a client can
  // only match its own count against the bands, which says "somebody scored this" and not
  // "you are in here". A round whose row the IP cap refused, or a Word daily the other
  // device submitted first, then borrows an unrelated player's standing.
  //
  // Nothing BINDS it to the caller, exactly as on /board: a publicId is broadcast by design
  // (an invite link IS one) and this only ever reads a population the same id can already
  // reach there.
  const id = event.queryStringParameters?.id;
  if (id !== undefined && !PUBLIC_ID_PATTERN.test(id)) {
    return errorResponse(400, 'bad_request', 'Query parameter "id" must be a player id.', responseHeaders);
  }

  // A score population exists only for a published daily.
  const puzzle =
    mode === 'word'
      ? await puzzleStore.getWordPuzzle(date, lang)
      : await puzzleStore.getPuzzle(date, lang);
  if (puzzle == null) {
    return errorResponse(
      404,
      'not_found',
      `No ${mode === 'word' ? 'word puzzle' : 'puzzle'} for ${date} (${lang}).`,
      responseHeaders,
      { date, lang },
    );
  }

  const key: ScoreKey = { date, lang, mode };
  const rows = await deps.scoreStore.list(key);
  // Null when the caller named nobody, and null when the population holds no row for them —
  // which is the honest "you are not in this" the client draws no standing for.
  const own = id === undefined ? null : rows.find((row) => row.publicId === id)?.score ?? null;
  return json(200, derivedHistogram(rows, own), responseHeaders);
}
