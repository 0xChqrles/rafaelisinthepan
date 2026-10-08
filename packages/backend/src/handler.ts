import {
  activeDate,
  bonusAddress,
  isBonusId,
  isCalendarDate,
  dateForDayNumber,
  dayNumber,
  decodeLegacyShareTarget,
  decodeResult,
  nextResetAt,
  secondsUntilNextReset,
  groupLandingPath,
  GROUP_ID_PATTERN,
  GROUP_SEGMENT,
  PREVIEW_REFUSED,
  PUBLIC_ID_PATTERN,
  SHARE_SEGMENT,
  SHARE_TOKEN_SOURCE,
  RESET_HOUR,
  TIME_ZONE,
  corsHeaders,
  preflightHeaders,
  type CardFace,
} from '@whippin/shared';
import {
  type FnUrlEvent,
  type FnUrlResult,
  ENVELOPE_BUDGET_BYTES,
  LAMBDA_MAX_RESPONSE_BYTES,
  envelopeBytes,
  errorResponse,
  html,
  json,
  jsonCompressed,
  png,
  redirect,
} from './respond';
import {
  renderCardPng,
  renderGroupCardPng,
  renderGoneHtml,
  renderGroupHtml,
  renderShareHtml,
  type ShareSigner,
} from './ogCard';
import { handleBoard } from './board';
import { handleDevices, type DeviceHandlerDeps } from './devices';
import type { DeviceStore } from './deviceStore';
import type { GroupStore } from './groupStore';
import { handleGroups, readGroupFace } from './groups';
import { handleHistory } from './history';
import { handleLink, type LinkHandlerDeps } from './link';
import { DATE_SKEW_DAYS, LIVE_HEADERS, previewGrant } from './liveRoute';
import { handleProfile } from './profile';
import { faceOf, type ProfileRecord, type ProfileStore } from './profileStore';
import { handleRound, type RoundHandlerDeps } from './rounds';
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
  // The score POPULATION (#169) — a read-only route since #203, since a finished round
  // records its own row. Optional only so read-only handler/unit consumers that never
  // touch /scores stay lightweight; production and the local server always provide it.
  scores?: ScoreHandlerDeps;
  // Player profiles (#188), same optionality rationale.
  profiles?: ProfileStore;
  // Groups (#271), same optionality rationale: the /groups route, the trusted boards and
  // the `/g/<id>` preview all read them.
  groups?: GroupStore;
  // Devices and the accounts they belong to (#216). EVERY authenticated route (/devices,
  // /profile, /groups, /board, /round, /history) resolves its caller through this ONE
  // top-level store — deliberately not a field of a route bundle, so two routes can never
  // be wired to two different stores, with half the private surface authenticating a
  // token the other half answers 401 `unknown_device` for.
  deviceStore?: DeviceStore;
  // The device ROUTE's own extras (#216): the Turnstile verifier its bootstrap is gated
  // by, and the local-adapter address trust flag.
  devices?: DeviceHandlerDeps;
  // The per-round guess log (#201) and the derived score (#203), same optionality
  // rationale. It carries a Turnstile verifier of its own because ROUND START is gated,
  // the score store because a finished round is
  // now what records the day's population, and the player-history store because a confirmed
  // solve credits the streak's solved day (#211) — which is also what `/history` reads.
  rounds?: RoundHandlerDeps;
  // Email account linking (#204), same optionality rationale. It is the one route bundle
  // that reaches ACROSS the others — a verified link moves the day's round and score rows,
  // credits the adopting account's solved days and drops a deleted account's group
  // memberships — so it carries those stores explicitly rather than reading them off
  // another route's deps.
  link?: LinkHandlerDeps;
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

const LANG_RE = /^[a-z]{2}$/;

// The share card (issue #8) is content-addressed by its token: a given URL's bytes are fixed
// (the render only changes on a deploy), and messaging apps cache the preview on THEIR side
// once unfurled — so a short origin TTL couldn't refresh an already-shared preview anyway.
// Cache it hard; a render-changing deploy (a card redesign) is covered because the backend
// deploy job invalidates `/*` on the API distribution.
const SHARE_MAX_AGE = 31_536_000;
// A SIGNED share (user-decided 2026-09-05) carries the player's publicId as a second
// segment — `/s/<token>/<publicId>`, card `/og/<token>/<publicId>.png` (`shared/invite.ts`
// spells both). The token is read exactly as before; the id is validated with the SHARED
// pattern, and the page is served under the group preview's short TTL because, like the
// group's, it names a player who can rename or redraw.
const OG_PNG_RE = new RegExp(`^/og/(${SHARE_TOKEN_SOURCE})(?:/([^/]+))?\\.png$`);
const SHARE_RE = new RegExp(`^/${SHARE_SEGMENT}/(${SHARE_TOKEN_SOURCE})(?:/([^/]+))?$`);

// The #271 group invite link and its card. Unlike a share token these are NOT
// content-addressed — members join, leave and redraw their marks — so they carry a short
// TTL instead of the share routes' year: a change reaches new unfurls in minutes, and the
// apps that already unfurled the link cached the picture on their side anyway. The id is
// matched loosely and validated with the SHARED pattern, so there is one spelling of what a
// group id is. The signed share's page (a player who can rename) shares the same TTL.
const PREVIEW_MAX_AGE = 300;
const GROUP_PAGE_RE = new RegExp(`^/${GROUP_SEGMENT}/([^/]+)$`);
const GROUP_CARD_RE = new RegExp(`^/og/${GROUP_SEGMENT}/([^/]+)\\.png$`);

// Everything the web distribution hands this origin lives under these prefixes. A path there
// that matched none of the routes above — a link a chat app or a copy mangled, `/s/<token>.`
// or `/g/<id>/x` — is a dead link like any other, never the puzzle route's JSON 400.
const PAGE_PREFIX_RE = new RegExp(`^/(${SHARE_SEGMENT}|${GROUP_SEGMENT})(/|$)`);
const CARD_PREFIX_RE = /^\/og(\/|$)/;

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

  // The face a PUBLIC page draws for a player — a signed share's. Best-effort, exactly
  // like a board row's dressing: the preview must always draw a face, so a failed read
  // falls back to the ASSIGNED identity (`anonName` / `defaultAvatar`, which the renderers
  // resolve) rather than failing the link. That fallback is the one answer NOT cached — an
  // assigned face held at the edge for a player who has drawn a real one is simply wrong,
  // where a 404 ("never customized") is the right answer and caches like any other. `live`
  // is false for an account an email link deleted (#204): the share falls back to plain.
  async function readFace(
    publicId: string,
  ): Promise<{ profile: ProfileRecord | null; answered: boolean; live: boolean }> {
    if (!deps.profiles) throw new Error('Player profiles are not configured.');
    try {
      const found = await deps.profiles.get(publicId);
      return { profile: found.profile, answered: true, live: found.live };
    } catch {
      return { profile: null, answered: false, live: true };
    }
  }

  return async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
    const method = event.requestContext?.http?.method ?? 'GET';
    const rawPath = event.rawPath ?? '/';
    const normalizedPath = rawPath.replace(/\/+$/, '') || '/';
    const isScoresRoute = normalizedPath === '/scores';
    // The profile route (#188) is live data with a write path, like /scores.
    const isProfileRoute = normalizedPath === '/profile';
    // Groups (#271): GET is a group's public face, POST the caller's own groups and every
    // membership write — the device token is the auth, in the body.
    const isGroupsRoute = normalizedPath === '/groups';
    // The leaderboard reads (#190): the same live shape once more — GET is the global
    // top 50, POST a group's boards (#271).
    const isBoardRoute = normalizedPath === '/board';
    // The per-round guess log (#201) — POST-only (the device token is the auth).
    const isRoundRoute = normalizedPath === '/round';
    // The private player history (#211): the archive calendar's month, the chooser's
    // status strip and the streak's solved-day list. POST-only for the same reason.
    const isHistoryRoute = normalizedPath === '/history';
    // Devices (#216): the lazy bootstrap that mints an identity, and the sign-out screen's
    // list + revocation. POST-only for the same reason — the token is the auth.
    const isDevicesRoute = normalizedPath === '/devices';
    // Email account linking (#204): the code, the verification, and the account adoption
    // behind it. POST-only for the same reason again.
    const isLinkRoute = normalizedPath === '/link';
    const isLiveRoute =
      isScoresRoute ||
      isProfileRoute ||
      isGroupsRoute ||
      isBoardRoute ||
      isRoundRoute ||
      isHistoryRoute ||
      isDevicesRoute ||
      isLinkRoute;
    const routeHeaders = isLiveRoute ? { ...cors, ...LIVE_HEADERS } : cors;

    // CORS preflight. It carries no data, so `no-store` belongs on the live ROUTES and
    // not on the permission check in front of them — what governs its reuse is
    // Access-Control-Max-Age, and a live route that writes on every guess (#201's
    // /round) is exactly the one that must not re-ask for permission each time. In
    // production the CDN answers a live route's preflight at the edge with these same
    // shared headers (infra `backend-stack.ts`); this answers `backend:dev`'s, and any
    // that reaches the origin.
    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: preflightHeaders(origin), body: '' };
    }
    if ((isLiveRoute && method !== 'GET' && method !== 'POST') || (!isLiveRoute && method !== 'GET')) {
      return errorResponse(405, 'method_not_allowed', `Method ${method} not allowed.`, routeHeaders);
    }

    try {
      // The #271 group invite link — the page a chat unfurls, and the card it unfurls
      // into. Both are addressed by the GROUP id, which is public by design (an invite link
      // IS one), so nothing here is authenticated. Nothing here writes either: the
      // membership is recorded by the SPA landing this page bounces to, with the CLICKER's
      // own key. Resolves before the puzzle logic for the share routes' reason — no lang,
      // no day, nothing to 400 on.
      const groupCard = GROUP_CARD_RE.exec(normalizedPath);
      const groupPage = groupCard ? null : GROUP_PAGE_RE.exec(normalizedPath);
      const groupMatch = groupCard ?? groupPage;
      if (groupMatch) {
        const groupId = groupMatch[1];
        const base = deps.siteOrigin ?? requestOrigin(event);
        // A dead PAGE link is still a 404 (a crawler unfurls nothing), but one a person's
        // browser moves on from; the card stays a JSON 404.
        if (!GROUP_ID_PATTERN.test(groupId)) {
          return groupCard
            ? errorResponse(404, 'not_found', 'Invalid invite link.', cors)
            : html(404, renderGoneHtml(`${base}/`), cors);
        }
        if (!deps.groups || !deps.profiles) throw new Error('Groups are not configured.');
        const face = await readGroupFace(deps.groups, deps.profiles, groupId);
        // A link naming no group is over: it expires rather than unfurling as an empty
        // card, and the landing it would bounce to refuses the join for the same reason —
        // which is where the page sends a person, to be told so.
        if (!face) {
          const headers = { ...cors, 'Cache-Control': `public, max-age=${PREVIEW_MAX_AGE}` };
          return groupCard
            ? errorResponse(404, 'not_found', 'This invite link has expired.', headers)
            : html(404, renderGoneHtml(`${base}${groupLandingPath(groupId)}`), headers);
        }
        // A face drawn from a FAILED profile read is the assigned fallback, and holding it
        // at the edge would put a stranger's mark on a member who drew their own.
        const cacheControl = face.answered ? `public, max-age=${PREVIEW_MAX_AGE}` : 'no-store';
        if (groupCard) {
          const buffer = await renderGroupCardPng({ name: face.group.name, members: face.members });
          return png(200, buffer, { 'Cache-Control': cacheControl });
        }
        return html(200, renderGroupHtml(groupId, face.group.name, base), {
          'Cache-Control': cacheControl,
        });
      }

      // Share-card routes (issue #8) are keyed only on the token — no lang/day/store — so
      // they resolve BEFORE the puzzle logic (which would otherwise 400 on the missing lang).
      const ogMatch = OG_PNG_RE.exec(normalizedPath);
      const shareMatch = ogMatch ? null : SHARE_RE.exec(normalizedPath);
      const routeMatch = ogMatch ?? shareMatch;
      if (routeMatch) {
        const token = routeMatch[1];
        const signedBy = routeMatch[2];
        // Canonical apex origin for the og:image, the game redirect and a dead link's page
        // (so they never depend on the CloudFront-to-CloudFront Host); the request origin is
        // the local-dev fallback.
        const base = deps.siteOrigin ?? requestOrigin(event);
        // A dead share PAGE is a 404 that moves a person on to the site home, the group
        // link's rule; a dead card stays a JSON 404.
        const gone = (message: string) =>
          ogMatch
            ? errorResponse(404, 'not_found', message, cors)
            : html(404, renderGoneHtml(`${base}/`), cors);
        if (signedBy !== undefined && !PUBLIC_ID_PATTERN.test(signedBy)) {
          return gone('Invalid share link.');
        }
        const result = decodeResult(token);
        // WHO signed it. An account an email link deleted (#204) signs nothing: the
        // result is still real, so the page falls back to the PLAIN share — the card
        // without a face — rather than expiring, since the score was never the part that
        // went away. A failed read draws the assigned identity and,
        // like the group preview, is the one answer not cached; an answered one is held
        // for the group preview's minutes. Read only for a token that names a result: the
        // 404 and the legacy redirect below draw no face.
        let by: (CardFace & ShareSigner) | null = null;
        let cacheControl = `public, max-age=${SHARE_MAX_AGE}, immutable`;
        if (result && signedBy !== undefined) {
          const { profile, answered, live } = await readFace(signedBy);
          cacheControl = answered ? `public, max-age=${PREVIEW_MAX_AGE}` : 'no-store';
          if (!answered || live) {
            by = { publicId: signedBy, ...faceOf(profile) };
          }
        }
        if (ogMatch) {
          // The DECODED result is handed straight to the renderer: `CardData` IS
          // `ShareResult`, so re-listing its fields here is a second declaration of the
          // same shape — and one that silently drops whatever the codec learns next. It
          // did exactly that with #214's `capped`, drawing a try count on a card whose own
          // share page already said `∞`.
          if (result) {
            return png(200, await renderCardPng(result, by), { 'Cache-Control': cacheControl });
          }
          return gone('Invalid share token.');
        }
        if (result) {
          const body = renderShareHtml(token, result, base, by);
          return html(200, body, { 'Cache-Control': cacheControl });
        }
        // A SUPERSEDED token (v1's bucketed squares can't feed the v2 ruler) still names a
        // real lang + day in the header every version shares, so send the reader to that
        // archived day instead of a dead end. Only the card is unrecoverable, and a
        // pre-bump link's preview has long since been cached by whatever unfurled it.
        const legacy = decodeLegacyShareTarget(token);
        if (legacy) {
          return redirect(301, `${base}/${legacy.lang}/${dateForDayNumber(legacy.dayNumber)}`, {
            'Cache-Control': `public, max-age=${SHARE_MAX_AGE}, immutable`,
          });
        }
        return gone('Invalid share token.');
      }
      if (PAGE_PREFIX_RE.test(normalizedPath)) {
        return html(404, renderGoneHtml(`${deps.siteOrigin ?? requestOrigin(event)}/`), cors);
      }
      if (CARD_PREFIX_RE.test(normalizedPath)) {
        return errorResponse(404, 'not_found', 'Invalid card link.', cors);
      }

      const instant = now();
      const date = activeDate(instant);

      if (isScoresRoute) {
        if (!deps.scores) throw new Error('Score collection is not configured.');
        return await handleScores(event, deps.store, deps.scores, date, cors);
      }

      if (isDevicesRoute) {
        if (!deps.devices || !deps.deviceStore) {
          throw new Error('Device identity is not configured.');
        }
        // Deleting an account (#207) acts through the LINK route's own stores — the one
        // account-lifecycle writer, and the group store its departures drain through — so
        // a deletion and a link can never be wired to two different instances.
        return await handleDevices(
          event,
          deps.deviceStore,
          deps.devices,
          instant,
          cors,
          deps.link ? { links: deps.link.links, groups: deps.link.groups } : undefined,
        );
      }

      if (isProfileRoute) {
        if (!deps.profiles) throw new Error('Player profiles are not configured.');
        if (!deps.deviceStore) throw new Error('Device identity is not configured.');
        return await handleProfile(event, deps.profiles, deps.deviceStore, instant, cors);
      }

      if (isGroupsRoute) {
        if (!deps.groups || !deps.profiles) throw new Error('Groups are not configured.');
        if (!deps.deviceStore) throw new Error('Device identity is not configured.');
        return await handleGroups(
          event,
          { groups: deps.groups, devices: deps.deviceStore, profiles: deps.profiles },
          instant,
          cors,
        );
      }

      if (isBoardRoute) {
        // The board is a READ over what the stores already hold — score rows for the
        // population, member lists for the trusted boards (#271), profiles to dress the
        // rows, and since #206 the members' stored ROUNDS plus the day's full artifact,
        // which the in-progress rows' exact try counts are deduped against.
        if (!deps.scores || !deps.profiles || !deps.groups || !deps.deviceStore) {
          throw new Error('The leaderboard is not configured.');
        }
        return await handleBoard(
          event,
          {
            scores: deps.scores.scoreStore,
            profiles: deps.profiles,
            groups: deps.groups,
            devices: deps.deviceStore,
            rounds: deps.rounds?.roundStore,
            puzzles: deps.store,
          },
          date,
          instant,
          cors,
        );
      }

      if (isRoundRoute) {
        if (!deps.rounds) throw new Error('Round state sync is not configured.');
        if (!deps.deviceStore) throw new Error('Device identity is not configured.');
        // The puzzle store is read on TWO paths here since #203 — the append's derivation
        // slice, and the full artifact a solve is scored from.
        return await handleRound(event, deps.store, deps.deviceStore, deps.rounds, date, instant, cors);
      }

      if (isLinkRoute) {
        if (!deps.link) throw new Error('Email account linking is not configured.');
        if (!deps.deviceStore) throw new Error('Device identity is not configured.');
        return await handleLink(event, deps.deviceStore, deps.link, instant, cors);
      }

      if (isHistoryRoute) {
        // A READ over what the two stores already hold: #203's derived summary on the
        // round rows, and the solved-day collection the round route credits.
        if (!deps.rounds) throw new Error('Round state sync is not configured.');
        if (!deps.deviceStore) throw new Error('Device identity is not configured.');
        return await handleHistory(
          event,
          {
            rounds: deps.rounds.roundStore,
            history: deps.rounds.history,
            devices: deps.deviceStore,
          },
          instant,
          cors,
        );
      }

      if (normalizedPath.endsWith('/today')) {
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

      // The puzzle endpoint is DATE-addressed: the client computes the active 22:00-ET
      // day (shared day.ts) and names it explicitly, so what is served is exactly what
      // was asked. A missing or malformed date is a protocol violation. A BONUS puzzle
      // (shared bonus.ts) is addressed by its id instead — no day, so no future guard:
      // a bonus is out the moment it is published, and only its link reaches it.
      const bonus = event.queryStringParameters?.bonus;
      let address: string;
      // A refused preview code is a 404 with the short negative TTL, like a day not yet out
      // (the web reads this route by status: NO PUZZLE), under its own code — the one
      // `/round` answers too (shared `PREVIEW_REFUSED`).
      const previewRefused = (asked: string): FnUrlResult =>
        errorResponse(
          404,
          PREVIEW_REFUSED,
          `No puzzle for ${asked} (${lang}) under this preview code.`,
          { ...cors, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
          { date, lang },
        );
      if (bonus !== undefined) {
        if (!isBonusId(bonus)) {
          return errorResponse(
            400,
            'bad_request',
            'Query parameter "bonus" must be a bonus id (seven digits).',
            cors,
          );
        }
        address = bonusAddress(bonus);
        // A day PREVIEW CODE names a day, never a bonus: any code here is refused (below).
        if (previewGrant(event, lang, null, deps.rounds?.ipHmacSecret) === 'refused') {
          return previewRefused(address);
        }
      } else {
        const requestedDate = event.queryStringParameters?.date;
        if (!requestedDate || !isCalendarDate(requestedDate)) {
          return errorResponse(
            400,
            'bad_request',
            'Query parameter "date" is required (the active game day, "YYYY-MM-DD").',
            cors,
          );
        }

        // A DAY PREVIEW CODE (user-decided 2026-10-08; liveRoute.ts `previewGrant`) is read
        // BEFORE the future guard and the store: the code is part of this route's CACHE KEY,
        // so a request carrying one must carry THIS (lang, date)'s — any other is refused
        // here, or a random code would be a free uncached read of a multi-megabyte artifact.
        // The secret is the round route's: no round route, no preview anywhere.
        const grant = previewGrant(event, lang, requestedDate, deps.rounds?.ipHmacSecret);
        if (grant === 'refused') return previewRefused(requestedDate);

        // Guard only the FUTURE: any PAST day is servable (the archive is date-addressed),
        // but a day more than DATE_SKEW_DAYS ahead of the server's active day is not — that
        // keeps clock-skew tolerance around the flip (+1 is served) while a pre-published
        // buffer day never leaks early. Out-of-window is a 404 like a missing puzzle (same
        // graceful front-end path), with the short negative TTL so a corrected clock recovers
        // quickly. A valid preview code lifts it for its own day.
        if (grant !== 'granted' && dayNumber(requestedDate) - dayNumber(date) > DATE_SKEW_DAYS) {
          return errorResponse(
            404,
            'not_found',
            `"${requestedDate}" is not released yet (active day: ${date}).`,
            { ...cors, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
            { date, lang },
          );
        }
        address = requestedDate;
      }

      const puzzle = await deps.store.getPuzzle(address, lang);
      if (puzzle == null) {
        // Missing puzzle is a clean 404, never a 500.
        return errorResponse(
          404,
          'not_found',
          `No puzzle for ${address} (${lang}).`,
          { ...cors, 'Cache-Control': NOT_FOUND_CACHE_CONTROL },
          { date: address, lang },
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
          `[puzzle] payload_too_large: ${address} (${lang}) serialized to ${envelope} bytes` +
            ` as ${response.headers['Content-Encoding'] ?? 'identity'}` +
            ` (accept-encoding: ${event.headers?.['accept-encoding'] ?? 'absent'}),` +
            ` over the ${ENVELOPE_BUDGET_BYTES}-byte budget / ${LAMBDA_MAX_RESPONSE_BYTES}-byte runtime cap.`,
        );
        return errorResponse(
          500,
          'payload_too_large',
          // The BUDGET, not the runtime cap: the guard deliberately fires below the cap, so
          // citing the cap would tell the caller it exceeded a number it may not have.
          `The puzzle for ${address} (${lang}) exceeds the ${ENVELOPE_BUDGET_BYTES}-byte response budget.`,
          cors,
        );
      }
      return response;
    } catch (err) {
      // LOGGED for the payload guard's reason above: a handler that RETURNS a 500 is a
      // SUCCESSFUL invocation, so this line is the only trace the failure leaves in
      // CloudWatch. The detail stays in the log — an SDK message names the role, the table
      // and the bucket, and every route is reachable anonymously up to its first store call,
      // so the body says nothing of it. Its fields are read off the error rather than the
      // error handed over whole, which for an SDK failure is the entire response object.
      console.error(
        `[handler] internal_error: ${method} ${normalizedPath}`,
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : { message: String(err) },
      );
      return errorResponse(500, 'internal_error', 'Unexpected error.', routeHeaders);
    }
  };
}
