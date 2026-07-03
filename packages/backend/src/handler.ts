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
  json,
} from './respond';
import type { PuzzleStore } from './store';

export interface HandlerDeps {
  store: PuzzleStore;
  // Injectable clock + config so the handler is pure and testable.
  now?: () => Date;
  allowedOrigin?: string;
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

function route(rawPath: string | undefined): 'today' | 'puzzle' {
  const path = (rawPath ?? '/').replace(/\/+$/, '');
  return path.endsWith('/today') ? 'today' : 'puzzle';
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

      // Pass the puzzle through unchanged — its shape is the front's `Puzzle` schema.
      // Cache-Control depends on whether the request is VERSION-ADDRESSED (issue #42). `v`
      // is a pure cache-busting token — the handler keys only on `lang` — so it only governs
      // cacheability, not the body:
      //  - WITH ?v=<version>: the URL is content-addressed (its bytes never change), so the
      //    browser + CDN may hold it `immutable`. A republish yields a new version -> a new
      //    URL, never a stale hit here.
      //  - WITHOUT ?v= (the front's fallback when /today didn't resolve, or any direct/old
      //    caller): the URL is NOT content-addressed — the same /?lang= maps to different
      //    bytes across republishes/days — so it must NOT be cached hard, or a republish stays
      //    invisible until the entry expires. `no-store` keeps this rare path always fresh.
      const versioned = Boolean(event.queryStringParameters?.v);
      return json(200, puzzle, {
        ...cors,
        'Cache-Control': versioned ? `public, max-age=${PUZZLE_MAX_AGE}, immutable` : 'no-store',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      return errorResponse(500, 'internal_error', message, cors);
    }
  };
}
