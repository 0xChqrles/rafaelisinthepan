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
//   { token, deleteAccount: "<accountId>" }
//                                    — DELETE THE ACCOUNT (#207). The body NAMES the account
//                                      the caller believes it deletes (the #204 `erase`
//                                      confirmation's pattern): another account is 409
//                                      `account_changed` and nothing goes. Answered
//                                      `{deleted: true}` only once the deletion committed; a
//                                      replay after a lost answer authenticates no more and is
//                                      401 `unknown_device`, which the client reads as done.
//
// POST-only — the token is the auth and it travels in the BODY,
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
  PUBLIC_ID_PATTERN,
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
  header,
  LIVE_HEADERS,
  readJsonObject,
  requireDevice,
  requireDeviceToken,
  requireTurnstile,
} from './liveRoute';
import type { GroupStore } from './groupStore';
import type { LinkStore } from './linkStore';
import { departGroups, revokeDevices } from './purge';
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

// What DELETING an account (#207) acts on besides the device store: the link store owns the
// one deletion transaction (it is the account-lifecycle writer that already deletes accounts
// for #204), and the group store is how a deleted account leaves its groups at once. The
// handler hands this route the link route's own instances, so a deletion and a link can
// never act on two different stores.
export interface AccountDeletionDeps {
  links: LinkStore;
  groups: GroupStore;
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
  deletion?: AccountDeletionDeps,
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

  // BOOTSTRAP dispatches on the challenge: it is the one message here that may create
  // state, so it is the one that has to prove it is not a bot. A body carrying both a challenge and a revocation is asking for two different
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
    if (body.deleteAccount !== undefined) {
      return errorResponse(
        400,
        'bad_request',
        'An account is either bootstrapped or deleted, never both in one call.',
        responseHeaders,
      );
    }
    const token = requireDeviceToken(body, responseHeaders);
    if (!token.ok) return token.response;
    const challenge = await requireTurnstile(body, event, deps, responseHeaders, 'Device bootstrap');
    if (!challenge.ok) return challenge.response;
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

  if (body.deleteAccount !== undefined) {
    return deleteAccount(body, resolved, devices, deletion, instant, responseHeaders);
  }

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
    // the screen never has to guess what a write did (the live routes' house rule).
    const outcome = await devices.revoke(resolved.account.accountId, target, revokeKey);
    // `absent` is idempotent success: another concurrent request removed the BASE item, and
    // the eventually-consistent GSI is precisely where its stale row may remain. A mismatch
    // proves nothing about the selected row and therefore filters nothing.
    const removedKey = outcome === 'mismatch' ? undefined : revokeKey;
    return json(200, await listing(devices, resolved, removedKey), responseHeaders);
  }

  return json(200, await listing(devices, resolved), responseHeaders);
}

// How many times a deletion is tried when its account's ADDRESS changes under it (a bind
// landing between the read and the commit). One change is a race; three in one request is
// churn nobody is typing.
const DELETE_ATTEMPTS = 3;

// THE DELETION (#207). The ONE transaction is `LinkStore.deleteAccount` (the account row
// conditioned on the address this call authenticated with and on the calling device still
// being on it, the profile row, the binding, the purge job); once it commits, the account is gone for every surface, and what follows
// here only does NOW what the purge worker owes anyway — each step best-effort and LOGGED,
// never failing the answer, because the player's request has already been carried out.
async function deleteAccount(
  body: Record<string, unknown>,
  resolved: ResolvedDevice,
  devices: DeviceStore,
  deletion: AccountDeletionDeps | undefined,
  instant: Date,
  responseHeaders: Record<string, string>,
): Promise<FnUrlResult> {
  if (body.revoke !== undefined || body.revokeKey !== undefined) {
    return errorResponse(
      400,
      'bad_request',
      'An account is either deleted or one of its devices revoked, never both in one call.',
      responseHeaders,
    );
  }
  const named = body.deleteAccount;
  if (typeof named !== 'string' || !PUBLIC_ID_PATTERN.test(named)) {
    return errorResponse(
      400,
      'bad_request',
      'Body field "deleteAccount" must name the account being deleted.',
      responseHeaders,
    );
  }
  if (!deletion) throw new Error('Account deletion is not configured.');
  // Authenticated already, so this only re-reads the hash the store keys the device by.
  const token = requireDeviceToken(body, responseHeaders);
  if (!token.ok) return token.response;
  const tokenHash = deviceTokenHash(token.value);

  // The transaction is conditioned on the snapshot this request authenticated with (the
  // account, its address, this device on it), so a REFUSAL says only that the snapshot no
  // longer stands — not which of three things happened. The device is read AGAIN to tell
  // them apart, because each needs a different answer: gone (another tab or device of the
  // account deleted it first — 401 `unknown_device`, which the client reads as deleted); on
  // ANOTHER account (a link moved it — 409 `account_changed`, the one thing that code means
  // here); still on THIS one (its address changed under us — the player still asked to
  // delete exactly this account, so try again over what stands now).
  let current = resolved;
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
    const { accountId, email } = current.account;
    // The confirmation names what it destroys: a device that changed accounts since the
    // screen asked (a link on another tab) must not delete the one it holds now.
    if (named !== accountId) {
      return errorResponse(
        409,
        'account_changed',
        'This device no longer holds the account it asked to delete.',
        responseHeaders,
      );
    }
    const outcome = await deletion.links.deleteAccount({
      accountId,
      tokenHash,
      ...(email === undefined ? {} : { email }),
      now: instant.toISOString(),
    });
    if (outcome === 'deleted') {
      return afterDeletion(current, devices, deletion, responseHeaders);
    }
    const fresh = await devices.resolve(tokenHash);
    if (!fresh) {
      return errorResponse(401, 'unknown_device', 'This device is signed out.', responseHeaders);
    }
    current = fresh;
  }
  // An address that keeps changing inside one request is not a player linking it: fail
  // loudly (a 500 the client treats as an unknown outcome and re-reads) rather than guess.
  throw new Error('The account kept changing while it was being deleted.');
}

// What follows a committed deletion: only what the purge worker owes anyway, done NOW.
async function afterDeletion(
  resolved: ResolvedDevice,
  devices: DeviceStore,
  deletion: AccountDeletionDeps,
  responseHeaders: Record<string, string>,
): Promise<FnUrlResult> {
  const { accountId } = resolved.account;
  // a. Every device item, the calling one included (the index may not list it yet).
  //    Authentication already fails for every token — the account row is gone — so this
  //    only removes the items now rather than at the purge.
  try {
    await revokeDevices(devices, accountId, [resolved.device]);
  } catch (error) {
    console.warn(`[purge] device revocation of ${accountId} unfinished:`, error);
  }
  // b. The groups, NOW: other players see a member, so a deleted one may not wait for the
  //    worker to leave. Logged inside on a failure; the purge job runs it again.
  await departGroups(deletion.links, deletion.groups, accountId);
  return json(200, { deleted: true }, responseHeaders);
}
