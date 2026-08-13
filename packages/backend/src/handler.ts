import {
  activeDate,
  dateForDayNumber,
  dayNumber,
  decodeLegacyShareTarget,
  decodeResult,
  decodeWordResult,
  nextResetAt,
  secondsUntilNextReset,
  RESET_HOUR,
  TIME_ZONE,
} from '@whippin/shared';
import {
  type FnUrlEvent,
  type FnUrlResult,
  ENVELOPE_BUDGET_BYTES,
  LAMBDA_MAX_RESPONSE_BYTES,
  corsHeaders,
  envelopeBytes,
  errorResponse,
  html,
  json,
  jsonCompressed,
  png,
  redirect,
} from './respond';
import { renderCardPng, renderShareHtml, renderWordCardPng, renderWordShareHtml } from './ogCard';
import { isValidDate } from './layout';
import { handleScores, type ScoreHandlerDeps } from './scores';
import type { PuzzleStore } from './store';

export interface HandlerDeps {
  store: PuzzleStore;
  // Injectable clock + config so the handler is pure and testable.
  now?: () => Date;
  allowedOrigin?: string;
  // Canonical site origin (apex) for the share card's absolute URLs (#8). When unset, the
  // share HTML falls back to the request origin (local dev).
  siteOrigin?: string;
  // Score collection (#169). Optional only so read-only handler/unit consumers that never
  // touch /scores stay lightweight; production and the local server always provide it.
  scores?: ScoreHandlerDeps;
}

// 404s expire quickly so a puzzle uploaded slightly late becomes playable soon
// instead of being negatively cached until the next daily flip.
const NOT_FOUND_CACHE_CONTROL = 'public, max-age=60, s-maxage=60';

// The puzzle URL is DATE-addressed (/?lang=&date=YYYY-MM-DD): the client computes the
// active 22:00-ET day itself (shared day.ts) and asks for it by name, so a URL maps to
// one day's puzzle. The CDN caches it effectively forever (s-maxage; `pnpm puzzle:publish
// --s3` invalidates on republish), while browsers revalidate after a few minutes so a
// corrected puzzle still shows on a normal reload without any client-side scheme.
const PUZZLE_BROWSER_MAX_AGE = 300;
const PUZZLE_CDN_MAX_AGE = 31_536_000;

// How far (whole days) a requested date may sit AHEAD of the server's active day and
// still be served: +1 tolerates client clock skew around the 22:00 flip without exposing
// a pre-published future puzzle beyond the adjacent day. The PAST is open (the archive is
// date-addressed), so only the future is guarded.
const DATE_SKEW_DAYS = 1;

const LANG_RE = /^[a-z]{2}$/;

// The share card (issue #8) is content-addressed by its token: a given URL's bytes are fixed
// (the render only changes on a deploy), and messaging apps cache the preview on THEIR side
// once unfurled — so a short origin TTL couldn't refresh an already-shared preview anyway.
// Cache it hard; a render-changing deploy (a card redesign) is covered because the backend
// deploy job invalidates `/*` on the API distribution.
const SHARE_MAX_AGE = 31_536_000;
const OG_PNG_RE = /^\/og\/([A-Za-z0-9_-]+)\.png$/;
const SHARE_RE = /^\/s\/([A-Za-z0-9_-]+)$/;

// Absolute origin of THIS request — the same host serves /s, /og and the SPA, so it is the
// base for the OG image URL and the game redirect. Honors the CloudFront forwarded headers.
function requestOrigin(event: FnUrlEvent): string {
  const host = event.headers?.['x-forwarded-host'] ?? event.headers?.host ?? 'localhost';
  const proto =
    event.headers?.['x-forwarded-proto'] ?? (/^(localhost|127\.|\[?::1)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? (() => new Date());
  const origin = deps.allowedOrigin ?? '*';
  const cors = corsHeaders(origin);

  return async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
    const method = event.requestContext?.http?.method ?? 'GET';
    const rawPath = event.rawPath ?? '/';
    const normalizedPath = rawPath.replace(/\/+$/, '') || '/';
    const isScoresRoute = normalizedPath === '/scores';
    const routeHeaders = isScoresRoute ? { ...cors, 'Cache-Control': 'no-store' } : cors;

    // CORS preflight.
    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: { ...routeHeaders }, body: '' };
    }
    if ((isScoresRoute && method !== 'GET' && method !== 'POST') || (!isScoresRoute && method !== 'GET')) {
      return errorResponse(405, 'method_not_allowed', `Method ${method} not allowed.`, routeHeaders);
    }

    try {
      // Share-card routes (issue #8) are keyed only on the token — no lang/day/store — so
      // they resolve BEFORE the puzzle logic (which would otherwise 400 on the missing lang).
      const ogMatch = OG_PNG_RE.exec(rawPath);
      if (ogMatch) {
        const result = decodeResult(ogMatch[1]);
        if (result) {
          const buffer = await renderCardPng({
            lang: result.lang,
            dayNumber: result.dayNumber,
            score: result.score,
            trajectory: result.trajectory,
            solvedAt: result.solvedAt,
          });
          return png(200, buffer, {
            'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable`,
          });
        }
        // Word mode's token (#156): its own format in the same version namespace.
        const word = decodeWordResult(ogMatch[1]);
        if (word) {
          const buffer = await renderWordCardPng(word);
          return png(200, buffer, {
            'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable`,
          });
        }
        return errorResponse(404, 'not_found', 'Invalid share token.', cors);
      }
      const shareMatch = SHARE_RE.exec(rawPath);
      if (shareMatch) {
        // Canonical apex origin for both the og:image and the game redirect (so they never
        // depend on the CloudFront-to-CloudFront Host); the request origin is the local-dev
        // fallback.
        const base = deps.siteOrigin ?? requestOrigin(event);
        const result = decodeResult(shareMatch[1]);
        if (result) {
          const body = renderShareHtml(shareMatch[1], result, base);
          return html(200, body, {
            'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable`,
          });
        }
        // Word mode's token (#156): its own share page, click-through to the word route.
        const word = decodeWordResult(shareMatch[1]);
        if (word) {
          const body = renderWordShareHtml(shareMatch[1], word, base);
          return html(200, body, {
            'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable`,
          });
        }
        // A SUPERSEDED token (v1's bucketed squares can't feed the v2 ruler) still names a
        // real lang + day in the header every version shares, so send the reader to that
        // archived day instead of a dead end. Only the card is unrecoverable, and a
        // pre-bump link's preview has long since been cached by whatever unfurled it.
        const legacy = decodeLegacyShareTarget(shareMatch[1]);
        if (legacy) {
          return redirect(301, `${base}/${legacy.lang}/${dateForDayNumber(legacy.dayNumber)}`, {
            'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable`,
          });
        }
        return errorResponse(404, 'not_found', 'Invalid share token.', cors);
      }

      const instant = now();
      const date = activeDate(instant);

      if (isScoresRoute) {
        if (!deps.scores) throw new Error('Score collection is not configured.');
        return await handleScores(event, deps.store, deps.scores, date, instant, cors);
      }

      if (rawPath.replace(/\/+$/, '').endsWith('/today')) {
        // /today is a DIAGNOSTIC: the server's view of the active day + reset info. The
        // client computes the day itself (shared day.ts) and no longer reads this in
        // normal play — it exists to debug clock-skew reports. `no-store` so it is
        // always the server's live clock.
        return json(
          200,
          {
            date,
            dayNumber: dayNumber(date),
            timeZone: TIME_ZONE,
            resetHour: RESET_HOUR,
            nextResetAt: nextResetAt(instant).toISOString(),
            secondsUntilNextReset: secondsUntilNextReset(instant),
          },
          { ...cors, 'Cache-Control': 'no-store' },
        );
      }

      const lang = event.queryStringParameters?.lang;
      if (!lang || !LANG_RE.test(lang)) {
        return errorResponse(
          400,
          'bad_request',
          'Query parameter "lang" is required (two lowercase letters, e.g. "fr").',
          cors,
        );
      }

      // Which daily artifact (#156): the sentence puzzle (default) or Word mode's #154
      // single-word artifact. The mode is part of the URL, so the CDN caches the two
      // dailies as distinct entries; an unknown value is a protocol violation.
      const rawMode = event.queryStringParameters?.mode;
      if (rawMode !== undefined && rawMode !== 'sentence' && rawMode !== 'word') {
        return errorResponse(
          400,
          'bad_request',
          'Query parameter "mode" must be "sentence" or "word" when present.',
          cors,
        );
      }
      const mode = rawMode ?? 'sentence';

      // The puzzle endpoint is DATE-addressed: the client computes the active 22:00-ET
      // day (shared day.ts) and names it explicitly, so what is served is exactly what
      // was asked. A missing or malformed date is a protocol violation.
      const requestedDate = event.queryStringParameters?.date;
      if (!requestedDate || !isValidDate(requestedDate)) {
        return errorResponse(
          400,
          'bad_request',
          'Query parameter "date" is required (the active game day, "YYYY-MM-DD").',
          cors,
        );
      }

      // Guard only the FUTURE: any PAST day is servable (the archive is date-addressed),
      // but a day more than DATE_SKEW_DAYS ahead of the server's active day is not — that
      // keeps clock-skew tolerance around the flip (+1 is served) while a pre-published
      // buffer day never leaks early. Out-of-window is a 404 like a missing puzzle (same
      // graceful front-end path), with the short negative TTL so a corrected clock recovers
      // quickly.
      if (dayNumber(requestedDate) - dayNumber(date) > DATE_SKEW_DAYS) {
        return errorResponse(
          404,
          'not_found',
          `"${requestedDate}" is not released yet (active day: ${date}).`,
          { ...cors, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
          { date, lang },
        );
      }

      const puzzle =
        mode === 'word'
          ? await deps.store.getWordPuzzle(requestedDate, lang)
          : await deps.store.getPuzzle(requestedDate, lang);
      if (puzzle == null) {
        // Missing puzzle is a clean 404, never a 500.
        return errorResponse(
          404,
          'not_found',
          `No ${mode === 'word' ? 'word puzzle' : 'puzzle'} for ${requestedDate} (${lang}).`,
          { ...cors, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
          { date: requestedDate, lang },
        );
      }

      // Pass the puzzle through unchanged — its shape is the front's `Puzzle` schema.
      // The URL names the (date, lang) pair, so the CDN holds it via s-maxage until a
      // republish invalidates it (`pnpm puzzle:publish --s3`); browsers get the short
      // max-age so a corrected puzzle shows on a normal reload within minutes.
      //
      // Compressed when the client accepts it: a puzzle's rank maps run to several MB, and
      // the runtime's envelope cap is what a plain body hits first (see respond.ts).
      const response = jsonCompressed(200, puzzle, event.headers?.['accept-encoding'], {
        ...cors,
        'Cache-Control': `public, max-age=${PUZZLE_BROWSER_MAX_AGE}, s-maxage=${PUZZLE_CDN_MAX_AGE}`,
      });
      // A payload the runtime would refuse is answered here instead. Left to the runtime it
      // becomes a 413 the caller reads as a bare 502, with nothing in this handler's logs —
      // the failure mode that made a 6.5 MB puzzle look like a dead backend. Naming it keeps
      // the next oversized puzzle a five-second diagnosis.
      const envelope = envelopeBytes(response);
      if (envelope > ENVELOPE_BUDGET_BYTES) {
        // LOGGED as well as returned, because returning the 500 is not enough to be seen: a
        // handler that RETURNS an error status is still a SUCCESSFUL invocation, so Lambda's
        // Errors metric stays 0 and the log group shows a clean request — the same blind spot
        // the bare 502 had. This line is what actually puts the diagnosis in CloudWatch.
        console.error(
          `[puzzle] payload_too_large: ${requestedDate} (${lang}) serialized to ${envelope} bytes` +
            ` as ${response.headers['Content-Encoding'] ?? 'identity'}` +
            ` (accept-encoding: ${event.headers?.['accept-encoding'] ?? 'absent'}),` +
            ` over the ${ENVELOPE_BUDGET_BYTES}-byte budget / ${LAMBDA_MAX_RESPONSE_BYTES}-byte runtime cap.`,
        );
        return errorResponse(
          500,
          'payload_too_large',
          // The BUDGET, not the runtime cap: the guard deliberately fires below the cap, so
          // citing the cap would tell the caller it exceeded a number it may not have.
          `The puzzle for ${requestedDate} (${lang}) exceeds the ${ENVELOPE_BUDGET_BYTES}-byte response budget.`,
          cors,
        );
      }
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      return errorResponse(500, 'internal_error', message, routeHeaders);
    }
  };
}
