// The device route on the ONE handler: POST /devices (#216).
//
//   { token, turnstileToken }        — BOOTSTRAP: create this device's account and its one
//                                      device item, and answer with the ids the SERVER
//                                      assigned. Idempotent by token hash — a lost answer
//                                      after a committed write returns what already exists
//                                      rather than minting a second identity. Never echoes
//                                      the token back: the client already holds it.
//   { token }                        — LIST the account's devices (the sign-out screen).
//   { token, revoke: "<deviceId>", revokeKey: "<opaque>" }
//                                    — SIGN OUT one listed device by deleting its base item
//                                      directly, then answer with the list as it now stands.
//
// POST-only for the /friends reason — the token is the auth and it travels in the BODY,
// never a query string, so there is no way to ask about an account without proving you hold
// one of its devices. The route reads NO query parameter, which is what its CloudFront
// behavior's EMPTY allow-list says (the root AGENTS.md three-package contract); a production
// POST still needs `x-amz-content-sha256` over the exact body bytes (OAC).
//
// TURNSTILE sits on the one message that CREATES state. Account creation is available to
// every visitor — that is the whole point of the lazy bootstrap — so it carries the weight
// the round-creation gate carries (#203). Listing and revoking are calls an existing
// account makes about itself and cost none.
//
// An ARBITRARY unknown token never creates an identity: only this bootstrap, with a
// canonical token and a verified challenge, may. That is what stops a revoked device from
// silently becoming a fresh account on its next write.

import {
  DEVICE_ID_PATTERN,
  generateDeviceId,
  generatePublicId,
  isValidDeviceToken,
} from '@whippin/shared';
import {
  deviceTokenHash,
  type DeviceRecord,
  type DeviceStore,
  type ResolvedDevice,
} from './deviceStore';
import {
  clientIp,
  LIVE_HEADERS,
  readJsonObject,
  requireDevice,
  requireDeviceToken,
  requireTurnstileToken,
} from './liveRoute';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { TurnstileVerifier } from './turnstile';
import { parseUserAgent } from './userAgent';

// The DeviceStore itself is NOT here: every authenticated route resolves its caller
// through the ONE top-level `HandlerDeps.deviceStore`, so two routes can never be wired
// to two different stores — half the private surface authenticating against one while the
// other half answers 401 `unknown_device` from another.
export interface DeviceHandlerDeps {
  // Bootstrap is Turnstile-gated, so this route needs a verifier and a trusted address
  // exactly like the round route's START.
  turnstile: TurnstileVerifier;
  // Only the direct local HTTP adapter may trust its socket peer (the /scores rule).
  allowSourceIp?: boolean;
}

// What a device looks like to the screen that lists it. `current` is the one fact the
// client cannot work out for itself: it holds a token, never the device id behind it, until
// this route tells it.
function describe(device: DeviceRecord, currentDeviceId: string) {
  return {
    revokeKey: device.revokeKey,
    deviceId: device.deviceId,
    ...device.agent,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    current: device.deviceId === currentDeviceId,
  };
}

// The list comes off the GSI, which is eventually consistent BY DESIGN — DynamoDB refuses a
// consistent read on a global index. That lag is harmless for a device the caller is not
// looking at, and confusing for the two it IS: the one it just created (a bootstrap
// answering with an empty list) and the one it just revoked (a sign-out that appears to have
// done nothing). Both are corrected here from what this request already KNOWS, so the answer
// never contradicts the write it just made.
async function listing(
  devices: DeviceStore,
  resolved: ResolvedDevice,
  removedKey?: string,
): Promise<Record<string, unknown>> {
  const rows = (await devices.list(resolved.account.accountId)).filter(
    (row) => row.revokeKey !== removedKey,
  );
  const listed = rows.some((row) => row.deviceId === resolved.device.deviceId);
  const currentRemoved = removedKey === resolved.device.revokeKey;
  const all = listed || currentRemoved ? rows : [resolved.device, ...rows];
  return {
    accountId: resolved.account.accountId,
    deviceId: resolved.device.deviceId,
    devices: all.map((row) => describe(row, resolved.device.deviceId)),
  };
}

export async function handleDevices(
  event: FnUrlEvent,
  devices: DeviceStore,
  deps: DeviceHandlerDeps,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'POST') {
    return errorResponse(
      405,
      'method_not_allowed',
      'The devices route is POST-only: the device token authenticates in the body.',
      responseHeaders,
    );
  }

  const parsed = readJsonObject(event, 'Devices', responseHeaders);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // BOOTSTRAP dispatches on the challenge, the way Word mode's round START does: it is the
  // one message here that may create state, so it is the one that has to prove it is not a
  // bot. A body carrying both a challenge and a revocation is asking for two different
  // things at once.
  if (body.turnstileToken !== undefined) {
    if (body.revoke !== undefined || body.revokeKey !== undefined) {
      return errorResponse(
        400,
        'bad_request',
        'A device is either bootstrapped or revoked, never both in one call.',
        responseHeaders,
      );
    }
    const token = requireDeviceToken(body, responseHeaders);
    if (!token.ok) return token.response;
    const challenge = requireTurnstileToken(body, responseHeaders);
    if (!challenge.ok) return challenge.response;
    const remoteIp = clientIp(event, deps.allowSourceIp === true);
    if (!remoteIp) {
      throw new Error('Device bootstrap has no trusted client IP address.');
    }
    if (!(await deps.turnstile.verify(challenge.value, remoteIp))) {
      return errorResponse(403, 'turnstile_rejected', 'Turnstile token is invalid.', responseHeaders);
    }
    // The ids are minted HERE, from the shared generator, so the store stays a storage
    // contract and there is one spelling of what an id is. `bootstrap` ignores them when the
    // token already names a device.
    const resolved = await devices.bootstrap({
      tokenHash: deviceTokenHash(token.value),
      accountId: generatePublicId(),
      deviceId: generateDeviceId(),
      agent: parseUserAgent(header(event, 'user-agent')),
      now: instant.toISOString(),
    });
    return json(200, await listing(devices, resolved), responseHeaders);
  }

  const auth = await requireDevice(body, responseHeaders, devices, instant);
  if (!auth.ok) return auth.response;
  const resolved = auth.value;

  if (body.revoke === undefined && body.revokeKey !== undefined) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "revokeKey" is only valid with "revoke".',
      responseHeaders,
    );
  }

  if (body.revoke !== undefined) {
    const target = body.revoke;
    if (typeof target !== 'string' || !DEVICE_ID_PATTERN.test(target)) {
      return errorResponse(
        400,
        'bad_request',
        'Body field "revoke" must be a 16-character device id.',
        responseHeaders,
      );
    }
    const revokeKey = body.revokeKey;
    if (!isValidDeviceToken(revokeKey)) {
      return errorResponse(
        400,
        'bad_request',
        'Body field "revokeKey" must be the listed 64-character lowercase handle.',
        responseHeaders,
      );
    }
    // Revoking the CALLING device is allowed — signing this one out is a thing a person may
    // want, and refusing it would be a rule the screen then has to explain. A device id that
    // is not on this account simply removes nothing; the answer is the list either way, so
    // the screen never has to guess what a write did (the /friends house rule).
    const outcome = await devices.revoke(resolved.account.accountId, target, revokeKey);
    // `absent` is idempotent success: another concurrent request removed the BASE item, and
    // the eventually-consistent GSI is precisely where its stale row may remain. A mismatch
    // proves nothing about the selected row and therefore filters nothing.
    const removedKey = outcome === 'mismatch' ? undefined : revokeKey;
    return json(200, await listing(devices, resolved, removedKey), responseHeaders);
  }

  return json(200, await listing(devices, resolved), responseHeaders);
}

// The header lookup is case-insensitive: Function URL events lowercase their header names,
// but the local HTTP adapter passes through whatever the client sent.
function header(event: FnUrlEvent, name: string): string | undefined {
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}
