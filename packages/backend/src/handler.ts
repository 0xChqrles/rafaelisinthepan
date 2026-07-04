import {
  activeDate,
  dayNumber,
  nextResetAt,
  secondsUntilNextReset,
  RESET_HOUR,
  TIME_ZONE,
} from './day';
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
import { decodeResult } from '@whippin/shared';
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

// The versioned puzzle URL (/?lang=&v=<version>) is content-addressed: a given `v` maps to
// bytes that never change, so it can be cached hard on both the CDN and the browser. A
// republish yields a NEW version -> a NEW URL, so nothing here ever serves stale (issue
// #42). One day comfortably covers a puzzle's live window (and matches the CDN maxTtl).
const PUZZLE_MAX_AGE = 86_400;

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
        // /today is the FRESH version pointer (issue #42): it carries the current puzzle
        // `version` so the client can request the content-addressed /?lang=&v=<version>
        // URL. It must never be cached — else it could hand out a stale version and defeat
        // the whole scheme — so it is `no-store`. `version` is per-lang; when `lang` is
        // absent/invalid it is null (date/dayNumber are still useful without it).
        const todayLang = event.queryStringParameters?.lang;
        const version =
          todayLang && LANG_RE.test(todayLang)
            ? await deps.store.version(date, todayLang)
            : null;
        return json(
          200,
          {
            date,
            dayNumber: dayNumber(date),
            timeZone: dayOpts.timeZone,
            resetHour: dayOpts.resetHour,
            nextResetAt: nextResetAt(instant, dayOpts).toISOString(),
            secondsUntilNextReset: secondsUntilNextReset(instant, dayOpts),
            version,
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

      // The puzzle endpoint is version-addressed (issue #42): the client must carry the
      // `v` token it read from /today. Requiring it makes the contract explicit — a request
      // without `v` is a protocol violation, so 400 rather than silently serving a puzzle at
      // a non-content-addressed URL (which could then be cached wrong). `v` is not validated
      // against the current version: it's an opaque cache key, so any non-empty value is a
      // 200 with the current puzzle. The front reaches here only for a version /today
      // reported as present, so a stale/garbage `v` never happens in normal play.
      if (!event.queryStringParameters?.v) {
        return errorResponse(
          400,
          'bad_request',
          'Query parameter "v" is required — read it from /today?lang= (issue #42).',
          cors,
        );
      }

      const puzzle = await deps.store.getPuzzle(date, lang);
      if (puzzle == null) {
        // Missing puzzle is a clean 404, never a 500.
        return errorResponse(
          404,
          'not_found',
          `No puzzle for ${date} (${lang}).`,
          { ...cors, 'Cache-Control': dailyCacheControl(NOT_FOUND_MAX_AGE) },
          { date, lang },
        );
      }

      // Pass the puzzle through unchanged — its shape is the front's `Puzzle` schema. Every
      // hit here is version-addressed (the `v` guard above), so the URL is content-addressed
      // and safe to hold `immutable` on the browser + CDN: a republish yields a new version
      // -> a new URL, never a stale hit at this one (issue #42).
      //
      // X-Puzzle-Date stamps the day this puzzle was resolved for. The client fetches
      // /today then the puzzle; when the 22:00 flip lands BETWEEN the two, this endpoint
      // serves the NEXT day's puzzle under the previous day's `v` — the stamp lets the
      // client detect the mismatch and re-run the pair (the header must be CORS-exposed
      // for the cross-origin fetch to read it).
      return json(200, puzzle, {
        ...cors,
        'X-Puzzle-Date': date,
        'Access-Control-Expose-Headers': 'X-Puzzle-Date',
        'Cache-Control': `public, max-age=${PUZZLE_MAX_AGE}, immutable`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      return errorResponse(500, 'internal_error', message, cors);
    }
  };
}
