// The PRIVATE player-history route on the ONE handler: POST /history?lang=&mode=[&month=].
//
//   { secret }  — everything a summary surface may know about days it is not opening:
//                 the asked-for MONTH of that (language, mode), and the language's
//                 SOLVED-DAY collection.
//
// #214 made the game deliberately network-dependent and removed the persisted sentence
// round, so the archive calendar, the language chooser and the streak lost the local
// materialized view they used to read. This is what replaced it (#211). It serves EVERY
// identity, linked or unlinked: after #214 it is the normal source on every device, not a
// linked-account enhancement.
//
// POST-only for the /friends reason — the secret is the auth (#187) and it travels in the
// BODY, never a query string, so there is no way to ask for someone else's history. The
// two things it reads are already stored:
//
//   the MONTH  — ONE Query over the caller's own round partition behind the
//                `<lang>#<mode>#<YYYY-MM>-` sort-key prefix #203 reordered the key for,
//                projected down to the `progress`/`solved` the server derived (#203). NO
//                second calendar row and no extra per-guess write: those fields already
//                ride the round mutation.
//   the STREAK — the solved-day collection on the private player row (historyStore.ts),
//                which the round route credits when it confirms a solve.
//
// `month` is OPTIONAL because the two readers want different things: the archive and the
// chooser want a calendar, while the game screen only needs the collection the streak
// choreography derives its previous/next values and its week row from — and making that
// read spend a month Query would be a whole calendar's cost per game load.
//
// This is a private, currently unmetered read whose cost scales with the caller's played
// rows (issue #211): monitor abnormal usage and act on the account rather than add a
// rate-limiting layer. Turnstile does not fit a NAVIGATION read — verification would add
// another external call to every month or chooser load.

import { HISTORY_MONTH_PATTERN, publicIdFromSecret } from '@whippin/shared';
import { LIVE_HEADERS, readJsonObject, requireGameParams, requireSecret } from './liveRoute';
import type { PlayerHistoryStore } from './historyStore';
import type { RoundStore } from './roundStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';

export interface HistoryDeps {
  // The round rows are the AUTHORITY for a day's summary — #211 adds no store of its own
  // for them, only this read over what #203 already writes.
  rounds: RoundStore;
  history: PlayerHistoryStore;
}

export async function handleHistory(
  event: FnUrlEvent,
  deps: HistoryDeps,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'POST') {
    return errorResponse(
      405,
      'method_not_allowed',
      'The history route is POST-only: the player key authenticates in the body.',
      responseHeaders,
    );
  }

  const game = requireGameParams(event, responseHeaders);
  if (!game.ok) return game.response;
  const { lang, mode } = game.value;

  // A MONTH, never a day: `YYYY-MM`. Absent asks for the solved-day collection alone.
  // There is deliberately no future guard — a month past the active day simply holds no
  // rows, and the archive clamps its own navigation anyway.
  const month = event.queryStringParameters?.month;
  if (month !== undefined && !HISTORY_MONTH_PATTERN.test(month)) {
    return errorResponse(
      400,
      'bad_request',
      'Query parameter "month" must be a calendar month ("YYYY-MM") when present.',
      responseHeaders,
    );
  }

  const parsed = readJsonObject(event, 'History', responseHeaders);
  if (!parsed.ok) return parsed.response;
  const secret = requireSecret(parsed.value, responseHeaders);
  if (!secret.ok) return secret.response;
  const publicId = await publicIdFromSecret(secret.value);

  // Neither read depends on the other, so the month Query and the collection's GetItem go
  // out together — the /round rule, where the slice fetch hides inside a round trip the
  // request was paying for anyway.
  const [days, solvedDays] = await Promise.all([
    month === undefined
      ? Promise.resolve([])
      : deps.rounds.listMonth({ lang, mode, month }, publicId),
    deps.history.solvedDays(publicId, lang),
  ]);

  return json(200, { days, solvedDays }, responseHeaders);
}
