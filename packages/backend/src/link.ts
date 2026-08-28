// The email link route on the ONE handler: POST /link (#204).
//
//   { token }                                    — WHAT THIS ACCOUNT IS SAVED AS, and a
//                                                  chance to finish any friend merge a
//                                                  previous link left queued.
//   { token, email, turnstileToken, lang? }      — SEND a 6-digit code to that address.
//   { token, email, code, erase? }               — VERIFY it, and link.
//
// POST-only, and every message carries the device token in the BODY — the /friends rule, and
// the reason this route reads NO query parameter at all (its CloudFront behavior's allow-list
// is EMPTY, the standing three-package contract). A production POST needs
// `x-amz-content-sha256` over the exact body bytes, like every other write here.
//
// **ONE FLOW.** The player types their address, then the code. Only AFTER the code is
// verified does the server branch — telling someone "we know this email" before they prove
// they own it is account enumeration — and the branch is:
//
//   address unknown              -> BIND it to the account this device already holds.
//   address is this account's    -> nothing to do; say so.
//   address is ANOTHER account's -> ADOPT that account. The device leaves the one it held.
//
// So the player never has to say whether they are new or returning, which is what makes the
// second-device problem tractable: there is nothing to detect.
//
// **THE ACCOUNT BEING LEFT IS DELETED ONLY WHEN IT CARRIES NO EMAIL OF ITS OWN.** One that
// does can be signed back into from any future device, so it is not an orphan — the device
// simply leaves it, nothing is destroyed, and nothing transfers. One that does not becomes
// unreachable the moment this device leaves, and that is the only case the erase exists for.
//
// **THE ERASE IS CONFIRMED, NOT INFERRED.** The server can work out which account is being
// left — it authenticated the device that holds it — but requiring the caller to NAME it
// turns destruction into a deliberate act: a first call with no `erase` answers 409
// `would_erase` with what is at stake, the screen says so, the player confirms, and the
// second call carries the name. A client bug then cannot silently destroy a month of play.
// The confirmation is skipped when there is nothing to show and when nothing is being
// deleted at all — a fresh device that links immediately loses nothing, so no dialog.

import { randomInt } from 'node:crypto';
import {
  activeDate,
  dayNumber,
  isValidLinkCode,
  normalizeEmail,
  LINK_CODE_MAX_ATTEMPTS,
  LINK_CODE_TTL_SECONDS,
  LINK_SENDS_PER_ADDRESS,
  LINK_SENDS_PER_IP,
  LINK_SEND_WINDOW_SECONDS,
  PUBLIC_ID_PATTERN,
  VOCAB_BUILDS,
} from '@whippin/shared';
import { accountStakes, drainMerges, transferActiveDay } from './accountLink';
import { deviceTokenHash, type DeviceStore } from './deviceStore';
import type { FriendStore } from './friendStore';
import type { PlayerHistoryStore } from './historyStore';
import { emailHash, linkCodeHash, type LinkStore } from './linkStore';
import {
  clientIp,
  LIVE_HEADERS,
  readJsonObject,
  requireDevice,
  requireDeviceToken,
  requireTurnstileToken,
} from './liveRoute';
import { linkCodeMail, type Mailer } from './mailer';
import type { RoundStore } from './roundStore';
import { hashClientIp } from './scores';
import type { ScoreStore } from './scoreStore';
import { errorResponse, json, type FnUrlEvent, type FnUrlResult } from './respond';
import type { TurnstileVerifier } from './turnstile';

export interface LinkHandlerDeps {
  links: LinkStore;
  friends: FriendStore;
  rounds: RoundStore;
  scores: ScoreStore;
  history: PlayerHistoryStore;
  mailer: Mailer;
  // SENDING a code creates state and puts a message in somebody else's inbox, so it is
  // gated exactly like a device bootstrap and a round start.
  turnstile: TurnstileVerifier;
  // The server secret the address allowance's IP is hashed with (#169). A raw address is
  // never stored.
  ipHmacSecret: string;
  // Only the direct local HTTP adapter may trust its socket peer (the /scores rule).
  allowSourceIp?: boolean;
}

// Six digits, leading zeros kept, from a CSPRNG. `randomInt` is uniform over the range —
// `Math.random() * 1e6` is neither uniform nor unpredictable, and an attacker who can
// predict the code needs no inbox at all.
function mintCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function handleLink(
  event: FnUrlEvent,
  devices: DeviceStore,
  deps: LinkHandlerDeps,
  instant: Date,
  cors: Record<string, string>,
): Promise<FnUrlResult> {
  const responseHeaders = { ...cors, ...LIVE_HEADERS };
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'POST') {
    return errorResponse(
      405,
      'method_not_allowed',
      'The link route is POST-only: the device token authenticates in the body.',
      responseHeaders,
    );
  }

  const parsed = readJsonObject(event, 'Link', responseHeaders);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // The route DISPATCHES on the body, the /devices and /round rule. A body carrying both a
  // challenge and a code is asking for two different things at once.
  const wantsSend = body.turnstileToken !== undefined;
  const wantsVerify = body.code !== undefined;
  if (wantsSend && wantsVerify) {
    return errorResponse(
      400,
      'bad_request',
      'A call either asks for a code or verifies one, never both.',
      responseHeaders,
    );
  }

  const token = requireDeviceToken(body, responseHeaders);
  if (!token.ok) return token.response;
  const auth = await requireDevice(body, responseHeaders, devices, instant);
  if (!auth.ok) return auth.response;
  const account = auth.value.account;

  if (!wantsSend && !wantsVerify) {
    // The READ. It also DRAINS: a friend merge left unfinished by an interrupted link is
    // resumed by the account's own next call here, which is what the client retries.
    const merged = await drainMerges(deps.links, deps.friends, account.accountId);
    return json(
      200,
      {
        accountId: account.accountId,
        deviceId: auth.value.device.deviceId,
        email: account.email ?? null,
        // WHEN this account began. It costs nothing — the row was read to authenticate the
        // call — and it is the one true thing the account screen can say about an identity
        // whose name and mark it already draws.
        createdAt: account.createdAt,
        mergePending: !merged,
      },
      responseHeaders,
    );
  }

  const email = normalizeEmail(body.email);
  if (email === null) {
    return errorResponse(
      400,
      'bad_email',
      'Body field "email" must be an email address.',
      responseHeaders,
    );
  }
  const hash = emailHash(email);

  if (wantsSend) {
    const challenge = requireTurnstileToken(body, responseHeaders);
    if (!challenge.ok) return challenge.response;
    const remoteIp = clientIp(event, deps.allowSourceIp === true);
    if (!remoteIp) {
      throw new Error('Link code request has no trusted client IP address.');
    }
    // Turnstile BEFORE the allowances, deliberately: the allowances are spent per address,
    // so checking them first would let an unauthenticated caller burn a stranger's code
    // budget and deny them a link they never asked to lose.
    if (!(await deps.turnstile.verify(challenge.value, remoteIp))) {
      return errorResponse(403, 'turnstile_rejected', 'Turnstile token is invalid.', responseHeaders);
    }
    const lang = typeof body.lang === 'string' && Object.hasOwn(VOCAB_BUILDS, body.lang)
      ? body.lang
      : 'en';
    // Two bounds, both spent before a single message is sent: per ADDRESS, so no inbox can
    // be made to receive an endless stream; per IP, so no one sender can spray many. Without
    // them this endpoint is a free spam relay pointed at arbitrary addresses.
    const allowances: [string, string, number][] = [
      ['addr', hash, LINK_SENDS_PER_ADDRESS],
      ['ip', hashClientIp(remoteIp, deps.ipHmacSecret), LINK_SENDS_PER_IP],
    ];
    for (const [scope, key, limit] of allowances) {
      const allowed = await deps.links.spendSend(
        scope,
        key,
        limit,
        LINK_SEND_WINDOW_SECONDS,
        instant,
      );
      if (!allowed) {
        return errorResponse(
          429,
          'too_many_codes',
          'Too many codes requested. Try again later.',
          { ...responseHeaders, 'Retry-After': String(LINK_SEND_WINDOW_SECONDS) },
        );
      }
    }
    const code = mintCode();
    await deps.links.putChallenge(hash, {
      // HASHED, never the code: a six-digit value is one in a million, so a table dump of
      // plain codes is every pending link at once.
      codeHash: linkCodeHash(deps.ipHmacSecret, email, code),
      attempts: 0,
      createdAt: instant.toISOString(),
      expiresAt: Math.floor(instant.getTime() / 1000) + LINK_CODE_TTL_SECONDS,
    });
    // Sent AFTER the challenge is stored: a mail whose code the server does not hold is a
    // code that can never work, which reads to the player as a broken product.
    await deps.mailer.send(linkCodeMail(email, code, lang));
    // The answer says NOTHING about whether this address is known — that branch is what the
    // code exists to earn, and answering it here would be account enumeration.
    return json(200, { sent: true, expiresIn: LINK_CODE_TTL_SECONDS }, responseHeaders);
  }

  // ── VERIFY ────────────────────────────────────────────────────────────────────────────
  if (!isValidLinkCode(body.code)) {
    return errorResponse(400, 'bad_request', 'Body field "code" must be six digits.', responseHeaders);
  }
  // The two CONFIRMATIONS, both of which name the account being left rather than merely
  // agreeing: `erase` when it will be deleted, `leave` when it survives and this device is
  // only walking away from it. A client bug then cannot destroy a month of play, and cannot
  // silently change whose account this device is either.
  for (const field of ['erase', 'leave'] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== 'string' || !PUBLIC_ID_PATTERN.test(value))) {
      return errorResponse(
        400,
        'bad_request',
        `Body field "${field}" must be a 16-character player id when present.`,
        responseHeaders,
      );
    }
  }

  const verdict = await deps.links.verify(
    hash,
    linkCodeHash(deps.ipHmacSecret, email, body.code),
    instant,
  );
  switch (verdict.outcome) {
    case 'none':
      return errorResponse(404, 'no_code', 'No code was asked for this address.', responseHeaders);
    case 'expired':
      return errorResponse(409, 'code_expired', 'That code has expired.', responseHeaders);
    case 'spent':
      return errorResponse(409, 'code_spent', 'That code has been used up.', responseHeaders);
    case 'wrong':
      return errorResponse(401, 'bad_code', 'That code is not right.', responseHeaders, {
        attemptsLeft: verdict.attemptsLeft,
        maxAttempts: LINK_CODE_MAX_ATTEMPTS,
      });
    default:
      break;
  }

  const held = auth.value.device;
  const binding = await deps.links.binding(hash);

  if (binding === null) {
    // The address reaches nobody: bind it to the account this device already holds. An
    // account carries at most ONE address, so a device whose account is already saved under
    // a different one is refused rather than silently re-pointed — the old address would
    // reach an account nobody could ever sign into again.
    if (account.email !== undefined && account.email !== email) {
      return errorResponse(
        409,
        'account_linked',
        'This account is already saved under another address.',
        responseHeaders,
        { email: account.email },
      );
    }
    const outcome = await deps.links.bind({
      emailHash: hash,
      email,
      accountId: account.accountId,
      now: instant.toISOString(),
    });
    if (outcome === 'bound') {
      return json(
        200,
        {
          outcome: 'bound',
          accountId: account.accountId,
          deviceId: held.deviceId,
          email,
          mergePending: false,
        },
        responseHeaders,
      );
    }
    // `taken`: another device bound this address between the lookup and the write. That is
    // the ADOPT case, and it is answered as one — the same thing that would have happened
    // had the lookup seen it.
  }

  const target = binding?.accountId ?? (await deps.links.binding(hash))?.accountId;
  if (target === undefined) {
    // The binding vanished between two reads — a state nothing in this flow produces.
    throw new Error('Email binding disappeared during a link.');
  }

  if (target === account.accountId) {
    // Already this account's address. Nothing to move, nothing to erase, nothing to say but
    // so. The challenge is deliberately left standing rather than consumed: it can only ever
    // re-confirm the same account, and it expires on its own.
    return json(
      200,
      {
        outcome: 'already_bound',
        accountId: account.accountId,
        deviceId: held.deviceId,
        email,
        mergePending: false,
      },
      responseHeaders,
    );
  }

  // ── ADOPT ─────────────────────────────────────────────────────────────────────────────
  const leaving = account.accountId;
  const activeDay = dayNumber(activeDate(instant));
  // The account being left is deleted only when it carries NO address of its own.
  const erase = account.email === undefined;
  if (erase) {
    const stakes = await accountStakes(deps.history, leaving, activeDay);
    // EMPTY needs no dialog: there is nothing to state, so there is nothing to confirm.
    if (stakes.days > 0 && body.erase !== leaving) {
      return errorResponse(
        409,
        'would_erase',
        'Linking this address will delete the account this device is on.',
        responseHeaders,
        // BOTH SIDES OF THE FORK (#204's UX rework, vol. 2). The refusal used to name only
        // the account being destroyed, which draws a trade as pure loss — so the screen
        // could show what the tap costs but never what it buys. `target` is the account
        // being adopted, and it is what lets the confirmation put the two faces side by
        // side. It leaks nothing: this refusal fires only AFTER the code is verified, so
        // the caller has proved control of the address and the account behind it is
        // legitimately theirs to reach.
        { accountId: leaving, target, ...stakes },
      );
    }
  } else if (body.leave !== leaving) {
    // **LEAVING AN ACCOUNT IS CONFIRMED TOO, even when nothing is destroyed** (user-decided
    // 2026-08-28). The account this device holds carries an address of its own, so it
    // survives and stays reachable — but this device still stops being it: the name, the
    // mark, the streak and the friends on screen all become somebody else's. That happened
    // SILENTLY, which is the one outcome an identity change may not have; a player who typed
    // an address to SAVE their account, and turned out to have typed one that already
    // belongs to another, was simply moved to it with nothing said.
    //
    // Unlike the erase, it is NOT gated on there being anything at stake: nothing is lost
    // either way, so what is being confirmed is the SWITCH itself, and that is worth asking
    // about whatever the leaving account's day count happens to be. Naming the account being
    // left is what makes it deliberate, exactly as `erase` does.
    return errorResponse(
      409,
      'would_switch',
      'This device will leave the account it is on for the one at this address.',
      responseHeaders,
      { accountId: leaving, target },
    );
  }

  // The active day's play moves FIRST, and only when the account it is in is about to be
  // deleted (#204: when it survives, it keeps its own play — the right answer for an account
  // the player can sign back into). See `accountLink.ts` for why this order is the
  // recoverable one.
  const moved = erase
    ? await transferActiveDay(
        { rounds: deps.rounds, scores: deps.scores, history: deps.history },
        leaving,
        target,
        activeDate(instant),
      )
    : [];

  await deps.links.adopt({
    tokenHash: deviceTokenHash(token.value),
    deviceId: held.deviceId,
    from: leaving,
    to: target,
    erase,
    emailHash: hash,
    // The friend merge belongs to the deletion: an account that SURVIVES keeps its own
    // edges, and there is nothing to move.
    ...(erase ? { mergeFrom: leaving } : {}),
    now: instant.toISOString(),
  });

  // The fan-out the transaction promised. It is best-effort HERE — the identity has already
  // changed and the player is waiting on an answer about it — and durable in the job it
  // drains, so an unfinished merge is reported rather than lost.
  const merged = await drainMerges(deps.links, deps.friends, target);

  // THE RECEIPT. "We found your account" is a claim; the streak and the day count are the
  // evidence, and they are the first thing a returning player wants to check. Read AFTER
  // the adopt, so an active day that just moved across is already counted — the answer
  // describes the account the device now holds, not the one it held a moment ago.
  const stakes = await accountStakes(deps.history, target, activeDay);

  return json(
    200,
    {
      outcome: 'adopted',
      accountId: target,
      deviceId: held.deviceId,
      email,
      erased: erase ? leaving : null,
      moved: moved.length,
      mergePending: !merged,
      stakes,
    },
    responseHeaders,
  );
}
