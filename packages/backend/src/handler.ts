import {
  activeDate,
  dayNumber,
  decodeResult,
  nextResetAt,
  secondsUntilNextReset,
  RESET_HOUR,
  TIME_ZONE,
} from '@whippin/shared';
import {
  type FnUrlEvent,
  type FnUrlResult,
  corsHeaders,
  errorResponse,
  html,
  json,
  png,
} from './respond';
import { renderCardPng, renderShareHtml } from './ogCard';
import { isValidDate } from './layout';
import type { PuzzleStore } from './store';

export interface HandlerDeps {
  store: PuzzleStore;
  // Injectable clock + config so the handler is pure and testable.
  now?: () => Date;
  allowedOrigin?: string;
  // Canonical site origin (apex) for the share card's absolute URLs (#8). When unset, the
  // share HTML falls back to the request origin (local dev).
  siteOrigin?: string;
  timeZone?: string;
  resetHour?: number;
}

// 404s expire quickly so a puzzle uploaded slightly late becomes playable soon
// instead of being negatively cached until the next daily flip.
const NOT_FOUND_MAX_AGE = 60;

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
// Cache it hard; the rare render-changing deploy (a card redesign) needs a one-off CloudFront
// invalidation — see the DistributionId stack outputs.
const SHARE_MAX_AGE = 31_536_000;
const OG_PNG_RE = /^\/og\/([A-Za-z0-9_-]+)\.png$/;
const SHARE_RE = /^\/s\/([A-Za-z0-9_-]+)$/;

function route(rawPath: string | undefined): 'today' | 'puzzle' {
  const path = (rawPath ?? '/').replace(/\/+$/, '');
  return path.endsWith('/today') ? 'today' : 'puzzle';
}

// Absolute origin of THIS request — the same host serves /s, /og and the SPA, so it is the
// base for the OG image URL and the game redirect. Honors the CloudFront forwarded headers.
function requestOrigin(event: FnUrlEvent): string {
  const host = event.headers?.['x-forwarded-host'] ?? event.headers?.host ?? 'localhost';
  const proto =
    event.headers?.['x-forwarded-proto'] ?? (/^(localhost|127\.|\[?::1)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// Cache-Control aligned to the daily flip: used for the negative (404) TTL so a late upload
// becomes playable soon instead of being negatively cached until the next 22:00 ET reset.
function dailyCacheControl(ttl: number): string {
  return `public, max-age=${ttl}, s-maxage=${ttl}`;
}

export function createHandler(deps: HandlerDeps) {
  const now = deps.now ?? (() => new Date());
  const origin = deps.allowedOrigin ?? '*';
  const dayOpts = { timeZone: deps.timeZone ?? TIME_ZONE, resetHour: deps.resetHour ?? RESET_HOUR };
  const cors = corsHeaders(origin);

  return async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
    const method = event.requestContext?.http?.method ?? 'GET';

    // CORS preflight.
    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: { ...cors }, body: '' };
    }
    if (method !== 'GET') {
      return errorResponse(405, 'method_not_allowed', `Method ${method} not allowed.`, cors);
    }

    try {
      // Share-card routes (issue #8) are keyed only on the token — no lang/day/store — so
      // they resolve BEFORE the puzzle logic (which would otherwise 400 on the missing lang).
      const rawPath = event.rawPath ?? '/';
      const ogMatch = OG_PNG_RE.exec(rawPath);
      if (ogMatch) {
        const result = decodeResult(ogMatch[1]);
        if (!result) return errorResponse(404, 'not_found', 'Invalid share token.', cors);
        const buffer = await renderCardPng({
          lang: result.lang,
          dayNumber: result.dayNumber,
          score: result.score,
          squares: result.squares,
        });
        return png(200, buffer, { 'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable` });
      }
      const shareMatch = SHARE_RE.exec(rawPath);
      if (shareMatch) {
        const result = decodeResult(shareMatch[1]);
        if (!result) return errorResponse(404, 'not_found', 'Invalid share token.', cors);
        // Canonical apex origin for both the og:image and the game redirect (so they never
        // depend on the CloudFront-to-CloudFront Host); the request origin is the local-dev
        // fallback.
        const body = renderShareHtml(shareMatch[1], result, deps.siteOrigin ?? requestOrigin(event));
        return html(200, body, { 'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable` });
      }

      const instant = now();
      const date = activeDate(instant, dayOpts);

      if (route(event.rawPath) === 'today') {
        // /today is a DIAGNOSTIC: the server's view of the active day + reset info. The
        // client computes the day itself (shared day.ts) and no longer reads this in
        // normal play — it exists to debug clock-skew reports. `no-store` so it is
        // always the server's live clock.
        return json(
          200,
          {
            date,
            dayNumber: dayNumber(date),
            timeZone: dayOpts.timeZone,
            resetHour: dayOpts.resetHour,
            nextResetAt: nextResetAt(instant, dayOpts).toISOString(),
            secondsUntilNextReset: secondsUntilNextReset(instant, dayOpts),
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

      // The puzzle endpoint is DATE-addressed: the client computes the active 22:00-ET
      // day (shared day.ts) and names it explicitly, so what is served is exactly what
      // was asked — the old /today->puzzle pair (and its flip race) is gone. A missing
      // or malformed date is a protocol violation.
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
          { ...cors, 'Cache-Control': dailyCacheControl(NOT_FOUND_MAX_AGE) },
          { date, lang },
        );
      }

      const puzzle = await deps.store.getPuzzle(requestedDate, lang);
      if (puzzle == null) {
        // Missing puzzle is a clean 404, never a 500.
        return errorResponse(
          404,
          'not_found',
          `No puzzle for ${requestedDate} (${lang}).`,
          { ...cors, 'Cache-Control': dailyCacheControl(NOT_FOUND_MAX_AGE) },
          { date: requestedDate, lang },
        );
      }

      // Pass the puzzle through unchanged — its shape is the front's `Puzzle` schema.
      // The URL names the (date, lang) pair, so the CDN holds it via s-maxage until a
      // republish invalidates it (`pnpm puzzle:publish --s3`); browsers get the short
      // max-age so a corrected puzzle shows on a normal reload within minutes.
      return json(200, puzzle, {
        ...cors,
        'Cache-Control': `public, max-age=${PUZZLE_BROWSER_MAX_AGE}, s-maxage=${PUZZLE_CDN_MAX_AGE}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      return errorResponse(500, 'internal_error', message, cors);
    }
  };
}
