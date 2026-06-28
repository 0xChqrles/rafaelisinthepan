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

const LANG_RE = /^[a-z]{2}$/;

function route(rawPath: string | undefined): 'today' | 'puzzle' {
  const path = (rawPath ?? '/').replace(/\/+$/, '');
  return path.endsWith('/today') ? 'today' : 'puzzle';
}

// Cache-Control aligned to the daily flip: a puzzle stays fresh exactly until the next
// 22:00 ET reset, so the CDN serves it cache-hot all day and revalidates at the boundary.
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
          { ...cors, 'Cache-Control': dailyCacheControl(secondsUntilNextReset(instant, dayOpts)) },
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
      return json(200, puzzle, {
        ...cors,
        'Cache-Control': dailyCacheControl(secondsUntilNextReset(instant, dayOpts)),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error.';
      return errorResponse(500, 'internal_error', message, cors);
    }
  };
}
