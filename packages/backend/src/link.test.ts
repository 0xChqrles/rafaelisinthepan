import { describe, expect, it, vi } from 'vitest';
import { activeDate, dayNumber, LINK_SENDS_PER_ADDRESS } from '@whippin/shared';
import { FRIENDS_MAX } from './friendStore';
import { createHandler } from './handler';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryFriendStore } from './memoryFriendStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryLinkStore } from './memoryLinkStore';
import { emailHash } from './linkStore';
import { memoryProfileStore } from './memoryProfileStore';
import { memoryRoundStore } from './memoryRoundStore';
import { memoryScoreStore } from './memoryScoreStore';
import type { MailMessage } from './mailer';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';
import { seedDevice } from './testDevice';

// CONTRACT (#204). ONE flow: the player types an address, then the code. The server branches
// only AFTER the code is verified — telling somebody "we know this email" before they prove
// they own it is account enumeration — and the three branches are bind / already-bound /
// adopt. The account being LEFT is deleted only when it carries no address of its own, the
// erase is CONFIRMED rather than inferred, the active day's play moves with it, and the
// friend graph is merged.

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
  getSlice: async () => null,
};

const NOW = new Date('2026-08-26T12:00:00.000Z');
const DATE = activeDate(NOW);
const HASH = 'a'.repeat(64);

// `clock` is for the tests that move time: the rolling send window is a fact about WHEN,
// and a fixed instant cannot exercise it. `mail.fail` is for the SES boundary: a provider
// can refuse, time out, or answer ambiguously, and what the route does then is a decided
// behaviour rather than an accident.
function harness(clock: { now: Date } = { now: NOW }, mail: { fail?: unknown } = {}) {
  const devices = memoryDeviceStore();
  const profiles = memoryProfileStore((id) => devices.accountExists(id));
  const friends = memoryFriendStore();
  const rounds = memoryRoundStore();
  const scores = memoryScoreStore(() => clock.now);
  const history = memoryHistoryStore();
  const links = memoryLinkStore({ devices, profiles, rounds, scores });
  const sent: MailMessage[] = [];
  const handler = createHandler({
    store: emptyStore,
    now: () => clock.now,
    scores: { scoreStore: scores },
    profiles,
    friends,
    deviceStore: devices,
    devices: { turnstile: { verify: async () => true }, allowSourceIp: true },
    link: {
      links,
      friends,
      history,
      mailer: {
        async send(message) {
          if (mail.fail !== undefined) throw mail.fail;
          sent.push(message);
        },
      },
      turnstile: { verify: async () => true },
      ipHmacSecret: 'x'.repeat(32),
      allowSourceIp: true,
    },
  });
  return { handler, devices, profiles, friends, rounds, scores, history, links, sent };
}

function post(body: unknown, path = '/link'): FnUrlEvent {
  return {
    rawPath: path,
    requestContext: { http: { method: 'POST', sourceIp: '203.0.113.7' } },
    body: JSON.stringify(body),
  };
}

// The code only ever exists in the message that was sent — the store keeps a keyed HMAC of
// it, which is the whole point.
function codeOf(sent: MailMessage[]): string {
  const match = /(\d{6})/.exec(sent[sent.length - 1].text);
  if (!match) throw new Error('no code in the sent mail');
  return match[1];
}

async function askForCode(harnessed: ReturnType<typeof harness>, token: string, email: string) {
  const answer = await harnessed.handler(
    post({ token, email, turnstileToken: 'ok', lang: 'fr' }),
  );
  expect(answer.statusCode).toBe(200);
  return codeOf(harnessed.sent);
}

describe('email account linking (#204) — the code', () => {
  it('spends address and IP allowances atomically', async () => {
    const h = harness();
    const address = 'a'.repeat(64);
    await expect(
      h.links.spendSends(
        [
          { scope: 'addr', hash: address, limit: LINK_SENDS_PER_ADDRESS },
          { scope: 'ip', hash: 'b'.repeat(64), limit: 0 },
        ],
        3_600,
        NOW,
      ),
    ).resolves.toBe(false);

    // The refused IP did not consume the address increment that appeared before it.
    for (let count = 0; count < LINK_SENDS_PER_ADDRESS; count += 1) {
      await expect(
        h.links.spendSends(
          [{ scope: 'addr', hash: address, limit: LINK_SENDS_PER_ADDRESS }],
          3_600,
          NOW,
        ),
      ).resolves.toBe(true);
    }
  });

  it('bounds the sends over a ROLLING hour — an old send frees its slot, a bucket edge frees nothing', async () => {
    const clock = { now: new Date('2026-08-26T12:50:00.000Z') };
    const h = harness(clock);
    const me = await seedDevice(h.devices);
    const ask = () =>
      h.handler(post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }));
    // Five sends, one a minute, up to the top of the hour.
    for (let count = 0; count < LINK_SENDS_PER_ADDRESS; count += 1) {
      clock.now = new Date(`2026-08-26T12:5${count}:00.000Z`);
      expect((await ask()).statusCode).toBe(200);
    }
    // Crossing the top of the hour changes nothing: the window is the last hour, not the
    // wall clock's.
    clock.now = new Date('2026-08-26T13:10:00.000Z');
    expect((await ask()).statusCode).toBe(429);
    // An hour after the FIRST send, exactly one slot is back.
    clock.now = new Date('2026-08-26T13:50:00.001Z');
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(429);
  });

  it('sends a six-digit code and says nothing about whether the address is known', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const answer = await h.handler(
      post({ token: me.token, email: ' Zoe@Example.COM ', turnstileToken: 'ok', lang: 'fr' }),
    );

    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ sent: true });
    // Enumeration: the answer for a known address is byte-identical to the one for an
    // unknown one. Nothing in it names an account.
    expect(JSON.parse(answer.body).accountId).toBeUndefined();
    // NORMALIZED on the way out too: the mail goes to the canonical form, which is the one
    // the binding is keyed by.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe('zoe@example.com');
    expect(h.sent[0].text).toMatch(/\d{6}/);
    // In the caller's language, because a code mail arriving in the wrong one reads as
    // phishing — the one impression a "confirm it's you" message may not give.
    expect(h.sent[0].subject).toMatch(/code Whippin/);
  });

  it('refuses a malformed address before anything is stored or sent', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const answer = await h.handler(
      post({ token: me.token, email: 'not-an-address', turnstileToken: 'ok' }),
    );
    expect(answer.statusCode).toBe(400);
    expect(JSON.parse(answer.body).error).toBe('bad_email');
    expect(h.sent).toHaveLength(0);
  });

  it('bounds how many codes ONE address can be made to receive', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    for (let i = 0; i < LINK_SENDS_PER_ADDRESS; i += 1) {
      expect((await h.handler(post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }))).statusCode).toBe(200);
    }
    const refused = await h.handler(
      post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }),
    );
    expect(refused.statusCode).toBe(429);
    expect(JSON.parse(refused.body).error).toBe('too_many_codes');
    expect(h.sent).toHaveLength(LINK_SENDS_PER_ADDRESS);
  });

  it('counts a WRONG code against the challenge and spends it, but never a right one', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const code = await askForCode(h, me.token, 'zoe@example.com');
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

    const refused = await h.handler(post({ token: me.token, email: 'zoe@example.com', code: wrong }));
    expect(refused.statusCode).toBe(401);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'bad_code', attemptsLeft: 4 });

    // The right code still works, and verifying it twice does not spend attempts either —
    // one successful link legitimately verifies twice (the erase confirmation asks, the
    // player confirms).
    const ok = await h.handler(post({ token: me.token, email: 'zoe@example.com', code }));
    expect(ok.statusCode).toBe(200);
  });

  // THE WHOLE ATTEMPT LADDER, 1 through 6 (PR-227 review). The FIFTH mismatch is still a
  // mismatch — 401 `bad_code` with ZERO remaining, which is what makes the screen's "too
  // many wrong codes" line reachable at all — and only the SIXTH call, against a challenge
  // that no longer accepts an attempt, is the 409.
  it('answers every counted mismatch 401 bad_code — the fifth with none left — and the sixth 409', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const code = await askForCode(h, me.token, 'zoe@example.com');
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

    const seen: { status: number; error: unknown; attemptsLeft?: number }[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const answer = await h.handler(
        post({ token: me.token, email: 'zoe@example.com', code: wrong }),
      );
      const body = JSON.parse(answer.body) as { error?: unknown; attemptsLeft?: number };
      seen.push({ status: answer.statusCode, error: body.error, attemptsLeft: body.attemptsLeft });
    }

    expect(seen.slice(0, 5)).toEqual([
      { status: 401, error: 'bad_code', attemptsLeft: 4 },
      { status: 401, error: 'bad_code', attemptsLeft: 3 },
      { status: 401, error: 'bad_code', attemptsLeft: 2 },
      { status: 401, error: 'bad_code', attemptsLeft: 1 },
      // The one the old mapping turned into a 409 — the screen's only chance to say how
      // the code ran out.
      { status: 401, error: 'bad_code', attemptsLeft: 0 },
    ]);
    expect(seen[5]).toMatchObject({ status: 409, error: 'code_spent' });

    // And the CORRECT code is gone with the attempts: the challenge is exhausted.
    const right = await h.handler(post({ token: me.token, email: 'zoe@example.com', code }));
    expect(right.statusCode).toBe(409);
    expect(JSON.parse(right.body).error).toBe('code_spent');
  });

  it('answers a code nobody asked for as a missing challenge, not a wrong one', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const answer = await h.handler(post({ token: me.token, email: 'zoe@example.com', code: '000000' }));
    expect(answer.statusCode).toBe(404);
    expect(JSON.parse(answer.body).error).toBe('no_code');
  });

  it('lets only one final operation consume a code', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const code = await askForCode(h, me.token, 'zoe@example.com');

    const answers = await Promise.all([
      h.handler(post({ token: me.token, email: 'zoe@example.com', code })),
      h.handler(post({ token: me.token, email: 'zoe@example.com', code })),
    ]);
    expect(answers.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect(JSON.parse(answers.find(({ statusCode }) => statusCode === 409)!.body).error).toBe(
      'code_spent',
    );
  });

  it('serializes a resend with final consumption so the replacement code is never deleted', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const expiresAt = Math.floor(NOW.getTime() / 1_000) + 600;
    await h.links.putChallenge(HASH, {
      codeHash: 'old',
      attempts: 0,
      createdAt: NOW.toISOString(),
      expiresAt,
    });

    // The bind enters the memory transaction first; the resend linearizes after it and its
    // fresh challenge must remain standing. Before both writes shared the commit queue, the
    // resend could land during bind's await and then be deleted by the old code.
    const binding = h.links.bind({
      emailHash: HASH,
      codeHash: 'old',
      email: 'zoe@example.com',
      accountId: me.accountId,
      now: NOW.toISOString(),
    });
    const resend = h.links.putChallenge(HASH, {
      codeHash: 'new',
      attempts: 0,
      createdAt: NOW.toISOString(),
      expiresAt,
    });

    await expect(binding).resolves.toBe('bound');
    await resend;
    await expect(h.links.verify(HASH, 'new', NOW)).resolves.toMatchObject({ outcome: 'ok' });
  });
});

describe('email account linking (#204) — the three branches', () => {
  it('BINDS an unknown address to the account this device already holds', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const code = await askForCode(h, me.token, 'zoe@example.com');

    const answer = await h.handler(post({ token: me.token, email: 'zoe@example.com', code }));
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      outcome: 'bound',
      accountId: me.accountId,
      email: 'zoe@example.com',
    });

    // And the READ says so afterwards — that is what the profile screen shows.
    const read = await h.handler(post({ token: me.token }));
    expect(JSON.parse(read.body)).toMatchObject({
      accountId: me.accountId,
      email: 'zoe@example.com',
    });
  });

  it('says ALREADY BOUND for this account’s own address, changing nothing', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    await h.handler(
      post({
        token: me.token,
        email: 'zoe@example.com',
        code: await askForCode(h, me.token, 'zoe@example.com'),
      }),
    );
    const again = await h.handler(
      post({
        token: me.token,
        email: 'zoe@example.com',
        code: await askForCode(h, me.token, 'zoe@example.com'),
      }),
    );
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({
      outcome: 'already_bound',
      accountId: me.accountId,
    });
  });

  it('refuses a SECOND address for one account rather than orphaning the first', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    await h.handler(
      post({
        token: me.token,
        email: 'zoe@example.com',
        code: await askForCode(h, me.token, 'zoe@example.com'),
      }),
    );
    const answer = await h.handler(
      post({
        token: me.token,
        email: 'other@example.com',
        code: await askForCode(h, me.token, 'other@example.com'),
      }),
    );
    expect(answer.statusCode).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({
      error: 'account_linked',
      email: 'zoe@example.com',
    });
  });

  it('keeps the one-address invariant when two different binds race the same account', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const firstCode = await askForCode(h, me.token, 'first@example.com');
    const secondCode = await askForCode(h, me.token, 'second@example.com');

    const answers = await Promise.all([
      h.handler(post({ token: me.token, email: 'first@example.com', code: firstCode })),
      h.handler(post({ token: me.token, email: 'second@example.com', code: secondCode })),
    ]);
    expect(answers.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect(JSON.parse(answers.find(({ statusCode }) => statusCode === 409)!.body).error).toBe(
      'account_linked',
    );
    const read = await h.handler(post({ token: me.token }));
    expect(['first@example.com', 'second@example.com']).toContain(JSON.parse(read.body).email);
  });

  it('ADOPTS the bound account silently when the device that links is EMPTY', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );

    // A brand-new device — a reconnect after a sign-out is exactly this shape.
    const fresh = await seedDevice(h.devices);
    const answer = await h.handler(
      post({
        token: fresh.token,
        email: 'zoe@example.com',
        code: await askForCode(h, fresh.token, 'zoe@example.com'),
      }),
    );

    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      outcome: 'adopted',
      accountId: saved.accountId,
    });
    // The answer names the account it ARRIVED at and nothing else: what was left behind is
    // exactly what the confirmation stated before the player agreed to it (#204's review —
    // `erased` and `moved` were read by nothing).
    expect(JSON.parse(answer.body)).not.toHaveProperty('erased');
    expect(JSON.parse(answer.body)).not.toHaveProperty('moved');
    // The DEVICE moved; there is still exactly one device item for it.
    const resolved = await h.devices.resolve(
      (await import('./deviceStore')).deviceTokenHash(fresh.token),
    );
    expect(resolved?.account.accountId).toBe(saved.accountId);
    expect(resolved?.device.deviceId).toBe(fresh.deviceId);
    // And the empty account it left is gone — it carried no address, so nothing could ever
    // reach it again.
    await expect(h.devices.accountExists(fresh.accountId)).resolves.toBe(false);
  });

  it('answers a committed adoption even when the receipt cannot be read — the identity moved', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );
    const fresh = await seedDevice(h.devices);
    const code = await askForCode(h, fresh.token, 'zoe@example.com');
    const solvedDays = h.history.solvedDays.bind(h.history);
    h.history.solvedDays = async (accountId, lang) => {
      if (accountId === saved.accountId) throw new Error('history unavailable');
      return solvedDays(accountId, lang);
    };

    const answer = await h.handler(post({ token: fresh.token, email: 'zoe@example.com', code }));
    expect(answer.statusCode).toBe(200);
    // The receipt is DECORATIVE: an unreadable one is no receipt, never a failed link on a
    // device whose identity has already moved.
    expect(JSON.parse(answer.body)).toMatchObject({
      outcome: 'adopted',
      accountId: saved.accountId,
      stakes: null,
    });
    await expect(
      h.devices.resolve((await import('./deviceStore')).deviceTokenHash(fresh.token)),
    ).resolves.toMatchObject({ account: { accountId: saved.accountId } });
    await expect(h.devices.accountExists(fresh.accountId)).resolves.toBe(false);
  });
});

describe('email account linking (#204) — one transaction owns the adoption', () => {
  // Two saved accounts, and one unlinked account with TWO devices and today's play on it.
  async function twoTargets(h: ReturnType<typeof harness>) {
    const targets = [];
    for (const email of ['one@example.com', 'two@example.com']) {
      const saved = await seedDevice(h.devices);
      await h.handler(
        post({ token: saved.token, email, code: await askForCode(h, saved.token, email) }),
      );
      targets.push({ ...saved, email });
    }
    const first = await seedDevice(h.devices);
    const second = await seedDevice(h.devices, { accountId: first.accountId });
    const key = { date: DATE, lang: 'fr', mode: 'sentence' as const };
    await h.rounds.append({
      ...key,
      publicId: first.accountId,
      guesses: ['chat', 'chien'],
      puzzle: 'rev1',
      progress: 100,
      solved: true,
      now: NOW,
    });
    return { targets, first, second, key };
  }

  it('lets exactly ONE of two concurrent adoptions of one account carry its play — the other writes nothing', async () => {
    const h = harness();
    const { targets, first, second, key } = await twoTargets(h);
    const codes = [
      await askForCode(h, first.token, targets[0].email),
      await askForCode(h, second.token, targets[1].email),
    ];

    const answers = await Promise.all([
      h.handler(post({ token: first.token, email: targets[0].email, code: codes[0] })),
      h.handler(post({ token: second.token, email: targets[1].email, code: codes[1] })),
    ]);
    const statuses = answers.map(({ statusCode }) => statusCode);
    expect(statuses.sort()).toEqual([200, 409]);
    const won = answers.findIndex(({ statusCode }) => statusCode === 200);
    expect(JSON.parse(answers[1 - won].body).error).toBe('link_changed');

    // The day's play is in the winner's account, whole; the loser's target got nothing.
    const winner = targets[won];
    const loser = targets[1 - won];
    await expect(h.rounds.get(key, winner.accountId, 'rev1')).resolves.toMatchObject({
      guesses: ['chat', 'chien'],
    });
    await expect(h.rounds.get(key, loser.accountId, 'rev1')).resolves.toBeNull();
    await expect(h.devices.accountExists(first.accountId)).resolves.toBe(false);
  });
});

describe('email account linking (#204) — the erase confirmation', () => {
  it('never deletes a source account that wins a concurrent email bind', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'saved@example.com',
        code: await askForCode(h, saved.token, 'saved@example.com'),
      }),
    );
    const leaving = await seedDevice(h.devices);
    const adoptCode = await askForCode(h, leaving.token, 'saved@example.com');
    const bindCode = await askForCode(h, leaving.token, 'leaving@example.com');

    const answers = await Promise.all([
      h.handler(post({ token: leaving.token, email: 'leaving@example.com', code: bindCode })),
      h.handler(post({ token: leaving.token, email: 'saved@example.com', code: adoptCode })),
    ]);
    expect(answers.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);

    const sourceLive = await h.devices.accountExists(leaving.accountId);
    const sourceBinding = await h.links.binding(
      (await import('./linkStore')).emailHash('leaving@example.com'),
    );
    if (sourceLive) {
      expect(sourceBinding?.accountId).toBe(leaving.accountId);
    } else {
      // If adoption won, the losing bind transaction created no index pointing at the
      // account it deleted.
      expect(sourceBinding).toBeNull();
    }
  });

  it('REFUSES to erase an account with play behind it until the caller names it', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );
    const playing = await seedDevice(h.devices);
    await h.history.recordSolvedDay({
      publicId: playing.accountId,
      lang: 'fr',
      day: dayNumber(DATE),
    });
    await h.history.recordSolvedDay({
      publicId: playing.accountId,
      lang: 'fr',
      day: dayNumber(DATE) - 1,
    });

    const code = await askForCode(h, playing.token, 'zoe@example.com');
    const asked = await h.handler(post({ token: playing.token, email: 'zoe@example.com', code }));
    expect(asked.statusCode).toBe(409);
    // What is at stake, named: the account, its live streak and its day count — AND the
    // account being adopted (#204's UX rework vol. 2). A trade shown from one side reads as
    // pure loss, so the confirmation draws both faces, which it can only do if the refusal
    // says whose the other one is. It leaks nothing: this fires only after the code is
    // verified, so the caller has proved control of the address.
    expect(JSON.parse(asked.body)).toMatchObject({
      error: 'would_erase',
      accountId: playing.accountId,
      target: saved.accountId,
      streak: 2,
      best: 2,
      days: 2,
    });
    // Nothing was destroyed by ASKING.
    await expect(h.devices.accountExists(playing.accountId)).resolves.toBe(true);

    const confirmed = await h.handler(
      post({ token: playing.token, email: 'zoe@example.com', code, erase: playing.accountId }),
    );
    expect(confirmed.statusCode).toBe(200);
    // THE RECEIPT: an adopt answers what the recovered account HOLDS. "We found your
    // account" is a claim; these two numbers are its evidence, and the first thing a
    // returning player checks. Read after the adopt, so a transferred active day counts.
    expect(JSON.parse(confirmed.body)).toMatchObject({
      outcome: 'adopted',
      accountId: saved.accountId,
      // The RECEIPT is the three numbers every surface that states an account's worth uses.
      stakes: {
        streak: expect.any(Number),
        best: expect.any(Number),
        days: expect.any(Number),
      },
    });
    await expect(h.devices.accountExists(playing.accountId)).resolves.toBe(false);
  });

  // CONTRACT (#204's UX rework vol. 2, 2026-08-28): BINDING IS A CONSENT. A caller that
  // came to RECOVER an account did not ask to have its own bound to whatever address it
  // typed — and that is not a smaller version of what it wanted, it is a costly different
  // act: an account carries at most ONE address, so a mistyped one would spend the slot and
  // leave the account unable to be saved under the right one afterwards.
  it('refuses to BIND when the caller did not authorize it, and changes nothing', async () => {
    const h = harness();
    const device = await seedDevice(h.devices);
    const code = await askForCode(h, device.token, 'nobody@example.com');

    const refused = await h.handler(
      post({ token: device.token, email: 'nobody@example.com', code, bind: false }),
    );
    expect(refused.statusCode).toBe(404);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'no_account' });

    // The address is still free, and the account is still unsaved — so the player can
    // correct their typo and save under the address they actually meant.
    const saved = await h.handler(
      post({
        token: device.token,
        email: 'meant@example.com',
        code: await askForCode(h, device.token, 'meant@example.com'),
      }),
    );
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ outcome: 'bound', email: 'meant@example.com' });
  });

  it('still ADOPTS without the bind consent — it only ever withheld creating one', async () => {
    const h = harness();
    const home = await seedDevice(h.devices);
    await h.handler(
      post({ token: home.token, email: 'home@example.com', code: await askForCode(h, home.token, 'home@example.com') }),
    );
    const fresh = await seedDevice(h.devices);
    const answer = await h.handler(
      post({
        token: fresh.token,
        email: 'home@example.com',
        code: await askForCode(h, fresh.token, 'home@example.com'),
        bind: false,
      }),
    );
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ outcome: 'adopted', accountId: home.accountId });
  });

  // CONTRACT (#204's UX rework vol. 2, 2026-08-28): LEAVING AN ACCOUNT IS CONFIRMED TOO,
  // even when nothing is destroyed. The account survives and stays reachable by its own
  // address, but this device stops BEING it — the name, the mark, the streak and the friends
  // on screen become somebody else's — and that may not happen silently.
  it('asks before a device leaves a SAVED account for another, and destroys nothing', async () => {
    const h = harness();
    const a = await seedDevice(h.devices);
    await h.handler(
      post({ token: a.token, email: 'a@example.com', code: await askForCode(h, a.token, 'a@example.com') }),
    );
    const b = await seedDevice(h.devices);
    await h.handler(
      post({ token: b.token, email: 'b@example.com', code: await askForCode(h, b.token, 'b@example.com') }),
    );

    // B's device asks for A's address. Nothing is at stake, so the refusal carries no
    // numbers — but it names BOTH accounts, which is what draws the two faces.
    const asked = await h.handler(
      post({ token: b.token, email: 'a@example.com', code: await askForCode(h, b.token, 'a@example.com') }),
    );
    expect(asked.statusCode).toBe(409);
    expect(JSON.parse(asked.body)).toMatchObject({
      error: 'would_switch',
      accountId: b.accountId,
      target: a.accountId,
    });
    // Asking changed nothing: B still exists, and this device is still on it.
    await expect(h.devices.accountExists(b.accountId)).resolves.toBe(true);

    // Naming the account being left is what makes it deliberate — exactly as `erase` does.
    const confirmed = await h.handler(
      post({
        token: b.token,
        email: 'a@example.com',
        code: await askForCode(h, b.token, 'a@example.com'),
        leave: b.accountId,
      }),
    );
    expect(confirmed.statusCode).toBe(200);
    expect(JSON.parse(confirmed.body)).toMatchObject({
      outcome: 'adopted',
      accountId: a.accountId,
    });
    // The account it left survives, reachable by its own address.
    await expect(h.devices.accountExists(b.accountId)).resolves.toBe(true);
  });

  it('does NOT delete an account that carries an address of its own — it is simply left', async () => {
    const h = harness();
    const a = await seedDevice(h.devices);
    await h.handler(
      post({ token: a.token, email: 'a@example.com', code: await askForCode(h, a.token, 'a@example.com') }),
    );
    const b = await seedDevice(h.devices);
    await h.handler(
      post({ token: b.token, email: 'b@example.com', code: await askForCode(h, b.token, 'b@example.com') }),
    );

    // B's device links A's address. B can be signed back into from any future device, so it
    // is not an orphan: nothing is destroyed and nothing transfers. The device still has to
    // NAME the account it is leaving (the switch confirmation above), which is what
    // separates "nothing is destroyed" from "nothing is asked".
    const answer = await h.handler(
      post({
        token: b.token,
        email: 'a@example.com',
        code: await askForCode(h, b.token, 'a@example.com'),
        leave: b.accountId,
      }),
    );
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      outcome: 'adopted',
      accountId: a.accountId,
    });
    await expect(h.devices.accountExists(b.accountId)).resolves.toBe(true);
  });
});

describe('email account linking (#204) — the active-day transfer', () => {
  it('moves the day’s round and score to the adopting account, and credits its streak', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );

    // Someone plays today on a brand-new device, THEN links. Without the transfer they
    // would watch that round get erased.
    const playing = await seedDevice(h.devices);
    const key = { date: DATE, lang: 'fr', mode: 'sentence' as const };
    await h.rounds.append({
      ...key,
      publicId: playing.accountId,
      guesses: ['chat', 'chien'],
      puzzle: 'rev1',
      progress: 100,
      solved: true,
      now: NOW,
    });
    await h.scores.submit({
      ...key,
      publicId: playing.accountId,
      score: 2,
      submittedAt: NOW.toISOString(),
      revision: 'rev1',
      ipHash: 'h',
      expiresAt: 0,
      requestToken: 'r',
    });

    const answer = await h.handler(
      post({
        token: playing.token,
        email: 'zoe@example.com',
        code: await askForCode(h, playing.token, 'zoe@example.com'),
      }),
    );
    expect(answer.statusCode).toBe(200);

    await expect(h.rounds.get(key, saved.accountId, 'rev1')).resolves.toMatchObject({
      guesses: ['chat', 'chien'],
      solved: true,
    });
    await expect(h.rounds.get(key, playing.accountId, 'rev1')).resolves.toBeNull();
    await expect(h.scores.list(key)).resolves.toEqual([{ publicId: saved.accountId, score: 2 }]);
    // A transferred SENTENCE solve owes the adopting account's streak its day.
    await expect(h.history.solvedDays(saved.accountId, 'fr')).resolves.toEqual([dayNumber(DATE)]);
  });

  it('leaves a day the adopting account already played alone — two logs have no honest merge', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );
    const key = { date: DATE, lang: 'fr', mode: 'sentence' as const };
    await h.rounds.append({
      ...key,
      publicId: saved.accountId,
      guesses: ['souris'],
      puzzle: 'rev1',
      progress: 20,
      solved: false,
      now: NOW,
    });

    const playing = await seedDevice(h.devices);
    await h.rounds.append({
      ...key,
      publicId: playing.accountId,
      guesses: ['chat', 'chien'],
      puzzle: 'rev1',
      progress: 100,
      solved: true,
      now: NOW,
    });

    const answer = await h.handler(
      post({
        token: playing.token,
        email: 'zoe@example.com',
        code: await askForCode(h, playing.token, 'zoe@example.com'),
      }),
    );
    expect(answer.statusCode).toBe(200);
    // The destination keeps ITS log, and the source's dies with the account it was in.
    await expect(h.rounds.get(key, saved.accountId, 'rev1')).resolves.toMatchObject({
      guesses: ['souris'],
    });
  });

  // THE REGRESSION (PR-227 review): a Word run that claimed NOTHING records an EMPTY log —
  // #202 makes `submittedAt` its marker, never the log's length — and a real score row of
  // 0. Read as "no guesses", it is indistinguishable from a run merely STARTED, so the
  // transfer left it behind and the player's recorded, unrepeatable day was deleted with
  // the account. It must MOVE, score row and all.
  it('carries a SUBMITTED Word run that claimed nothing — with its score of 0', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );

    const key = { date: DATE, lang: 'fr', mode: 'word' as const };
    const playing = await seedDevice(h.devices);
    await h.rounds.start({
      ...key,
      publicId: playing.accountId,
      puzzle: 'rev1',
      runner: {
        deviceId: playing.deviceId,
        device: 'iPhone',
        os: 'iOS',
        browser: 'Chrome',
      },
      now: NOW,
    });
    await h.rounds.submit({
      ...key,
      publicId: playing.accountId,
      puzzle: 'rev1',
      deviceId: playing.deviceId,
      guesses: [],
      minElapsedMs: 0,
      now: NOW,
    });
    await h.scores.submit({
      ...key,
      publicId: playing.accountId,
      score: 0,
      submittedAt: NOW.toISOString(),
      revision: 'rev1',
      ipHash: 'iphash',
      expiresAt: Math.floor(NOW.getTime() / 1000) + 3600,
      requestToken: 'tok',
    });

    const answer = await h.handler(
      post({
        token: playing.token,
        email: 'zoe@example.com',
        code: await askForCode(h, playing.token, 'zoe@example.com'),
      }),
    );
    expect(answer.statusCode).toBe(200);

    // The recorded run moved WHOLE — its empty log, and the submission stamp that says it
    // is a finished day.
    const moved = await h.rounds.get(key, saved.accountId, 'rev1');
    expect(moved?.guesses).toEqual([]);
    expect(moved?.submittedAt).toBeTruthy();
    await expect(h.rounds.get(key, playing.accountId, 'rev1')).resolves.toBeNull();
    // And the score of 0 followed it, exactly as a non-zero one does.
    await expect(h.scores.list(key)).resolves.toEqual([{ publicId: saved.accountId, score: 0 }]);
  });

  it('does NOT carry a Word run that was merely STARTED — its claims are on the device', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );

    const key = { date: DATE, lang: 'fr', mode: 'word' as const };
    const playing = await seedDevice(h.devices);
    await h.rounds.start({
      ...key,
      publicId: playing.accountId,
      puzzle: 'rev1',
      runner: {
        deviceId: playing.deviceId,
        device: 'iPhone',
        os: 'iOS',
        browser: 'Chrome',
      },
      now: NOW,
    });

    await h.handler(
      post({
        token: playing.token,
        email: 'zoe@example.com',
        code: await askForCode(h, playing.token, 'zoe@example.com'),
      }),
    );
    await expect(h.rounds.get(key, saved.accountId, 'rev1')).resolves.toBeNull();
  });

  it('lets a submitted 0-claim run at the DESTINATION block a move — both days are recorded', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );

    const key = { date: DATE, lang: 'fr', mode: 'word' as const };
    const runner = (deviceId: string) => ({
      deviceId,
      device: 'iPhone',
      os: 'iOS',
      browser: 'Chrome',
    });
    // The DESTINATION already recorded an empty run of its own.
    await h.rounds.start({ ...key, publicId: saved.accountId, puzzle: 'rev1', runner: runner(saved.deviceId), now: NOW });
    await h.rounds.submit({
      ...key,
      publicId: saved.accountId,
      puzzle: 'rev1',
      deviceId: saved.deviceId,
      guesses: [],
      minElapsedMs: 0,
      now: NOW,
    });

    const playing = await seedDevice(h.devices);
    await h.rounds.start({ ...key, publicId: playing.accountId, puzzle: 'rev1', runner: runner(playing.deviceId), now: NOW });
    await h.rounds.submit({
      ...key,
      publicId: playing.accountId,
      puzzle: 'rev1',
      deviceId: playing.deviceId,
      guesses: ['chat'],
      minElapsedMs: 0,
      now: NOW,
    });

    await h.handler(
      post({
        token: playing.token,
        email: 'zoe@example.com',
        code: await askForCode(h, playing.token, 'zoe@example.com'),
      }),
    );
    // The destination's own recorded day stands; the source's dies with its account.
    const held = await h.rounds.get(key, saved.accountId, 'rev1');
    expect(held?.guesses).toEqual([]);
    expect(held?.submittedAt).toBeTruthy();
  });
});


// CONTRACT (user-decided, PR-227 review): the send order is SPEND -> STORE -> SEND, and a
// failed or ambiguous SES call is FAIL-CLOSED. Nothing is refunded and nothing is rolled
// back: SES acceptance is ambiguous — a timeout can follow a message that was delivered —
// so giving the allowance back would let a caller whose mail DID go out spend the slot
// again, and the bound would stop bounding what an inbox receives.
describe('email account linking (#204) — a failed SEND', () => {
  const sesFailure = () =>
    Object.assign(new Error('Email address is not verified: victim@example.com'), {
      name: 'MessageRejected',
      $metadata: { requestId: 'req-123', httpStatusCode: 400 },
    });

  it('answers 503 mail_unavailable — never a 200 for a code nobody received', async () => {
    const h = harness({ now: NOW }, { fail: sesFailure() });
    const me = await seedDevice(h.devices);
    const answer = await h.handler(
      post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }),
    );
    expect(answer.statusCode).toBe(503);
    expect(JSON.parse(answer.body).error).toBe('mail_unavailable');
    expect(h.sent).toEqual([]);
  });

  it('LOGS the failure without the address, the code or any digest', async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args);
    });
    try {
      const h = harness({ now: NOW }, { fail: sesFailure() });
      const me = await seedDevice(h.devices);
      const answer = await h.handler(
        post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }),
      );
      const printed = JSON.stringify({ logged, body: answer.body, headers: answer.headers });
      // The operational facts an on-call reader can act on.
      expect(printed).toContain('MessageRejected');
      expect(printed).toContain('req-123');
      // And nothing that identifies a person or lets a code be replayed. The provider's own
      // MESSAGE names the rejected destination, which is exactly why it is never logged.
      expect(printed).not.toContain('zoe@example.com');
      expect(printed).not.toContain('victim@example.com');
      expect(printed).not.toContain(me.token);
      expect(printed).not.toContain(emailHash('zoe@example.com'));
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves the allowance CHARGED — a failed send is not a refund', async () => {
    const h = harness({ now: NOW }, { fail: sesFailure() });
    const me = await seedDevice(h.devices);
    for (let i = 0; i < LINK_SENDS_PER_ADDRESS; i += 1) {
      const answer = await h.handler(
        post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }),
      );
      expect(answer.statusCode).toBe(503);
    }
    // Every one of them spent a slot, so the address is now at its bound — the abuse
    // control holds whatever the provider did with the messages.
    const refused = await h.handler(
      post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }),
    );
    expect(refused.statusCode).toBe(429);
    expect(JSON.parse(refused.body).error).toBe('too_many_codes');
  });

  it('leaves the stored challenge to be REPLACED by the next successful resend', async () => {
    // The failed send stored a code nobody can read. It is not deleted — deleting it would
    // be one more write on a path that has already failed — and the next accepted send
    // simply replaces it, which is what `putChallenge` does.
    const failing = { fail: sesFailure() as unknown };
    const h = harness({ now: NOW }, failing);
    const me = await seedDevice(h.devices);
    const lost = await h.handler(
      post({ token: me.token, email: 'zoe@example.com', turnstileToken: 'ok' }),
    );
    expect(lost.statusCode).toBe(503);

    failing.fail = undefined;
    const code = await askForCode(h, me.token, 'zoe@example.com');
    const answer = await h.handler(post({ token: me.token, email: 'zoe@example.com', code }));
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body).outcome).toBe('bound');
  });
});

describe('email account linking (#204) — the friend merge', () => {
  it('merges the leaving account’s friends in both directions, dropping duplicates', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );
    const leaving = await seedDevice(h.devices);
    const shared = await seedDevice(h.devices);
    const onlyTheirs = await seedDevice(h.devices);

    const at = '2026-08-01T00:00:00.000Z';
    await h.friends.link({ publicId: saved.accountId, friendId: shared.accountId, createdAt: at });
    await h.friends.link({ publicId: leaving.accountId, friendId: shared.accountId, createdAt: at });
    await h.friends.link({ publicId: leaving.accountId, friendId: onlyTheirs.accountId, createdAt: at });
    // The two accounts had even friended each other across devices.
    await h.friends.link({ publicId: leaving.accountId, friendId: saved.accountId, createdAt: at });

    const answer = await h.handler(
      post({
        token: leaving.token,
        email: 'zoe@example.com',
        code: await askForCode(h, leaving.token, 'zoe@example.com'),
      }),
    );
    expect(JSON.parse(answer.body).mergePending).toBe(false);

    await expect(h.friends.list(saved.accountId)).resolves.toEqual(
      [shared.accountId, onlyTheirs.accountId].sort(),
    );
    // Both directions, and nothing left pointing at the deleted account.
    await expect(h.friends.list(onlyTheirs.accountId)).resolves.toEqual([saved.accountId]);
    await expect(h.friends.list(shared.accountId)).resolves.toEqual([saved.accountId]);
    await expect(h.friends.list(leaving.accountId)).resolves.toEqual([]);
  });

  it('drops the friendships that do not fit, leaving no edge on a deleted account', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );
    const leaving = await seedDevice(h.devices);
    // The adopting account is FULL, so every one of the leaving account's own friendships
    // has to be dropped — and both facing rows have to go with them.
    const base32 = 'abcdefghijklmnopqrstuvwxyz234567';
    const fakeId = (n: number) => {
      let out = '';
      let value = n;
      for (let i = 0; i < 16; i += 1) {
        out = base32[value % 32] + out;
        value = Math.floor(value / 32);
      }
      return out;
    };
    for (let i = 0; i < FRIENDS_MAX; i += 1) {
      await h.friends.link({
        publicId: saved.accountId,
        friendId: fakeId(i),
        createdAt: '2026-08-01T00:00:00.000Z',
      });
    }
    const orphaned = await seedDevice(h.devices);
    await h.friends.link({
      publicId: leaving.accountId,
      friendId: orphaned.accountId,
      createdAt: '2026-08-02T00:00:00.000Z',
    });

    await h.handler(
      post({
        token: leaving.token,
        email: 'zoe@example.com',
        code: await askForCode(h, leaving.token, 'zoe@example.com'),
      }),
    );

    await expect(h.friends.list(saved.accountId)).resolves.toHaveLength(FRIENDS_MAX);
    await expect(h.friends.list(orphaned.accountId)).resolves.toEqual([]);
    await expect(h.friends.list(leaving.accountId)).resolves.toEqual([]);
  });
});

describe('email account linking (#204) — what a deleted account stops being', () => {
  it('expires its invite link and refuses the edge, rather than dressing a player who is gone', async () => {
    const h = harness();
    const saved = await seedDevice(h.devices);
    await h.handler(
      post({
        token: saved.token,
        email: 'zoe@example.com',
        code: await askForCode(h, saved.token, 'zoe@example.com'),
      }),
    );
    const leaving = await seedDevice(h.devices);
    await h.profiles.upsert({
      publicId: leaving.accountId,
      name: 'Zoe',
      avatar: 'AAAAAAAAAAAAAAAAAAA',
      now: NOW.toISOString(),
    });
    await h.handler(
      post({
        token: leaving.token,
        email: 'zoe@example.com',
        code: await askForCode(h, leaving.token, 'zoe@example.com'),
      }),
    );

    // The public read tells "gone" apart from "never customized": one dresses with the
    // assigned pseudonym and mark, the other must dress with nothing at all.
    const profile = await h.handler({
      rawPath: '/profile',
      requestContext: { http: { method: 'GET' } },
      queryStringParameters: { id: leaving.accountId },
    });
    expect(profile.statusCode).toBe(410);
    expect(JSON.parse(profile.body).error).toBe('account_gone');

    // And accepting their old invite link creates no edge.
    const stranger = await seedDevice(h.devices);
    const add = await h.handler(post({ token: stranger.token, add: leaving.accountId }, '/friends'));
    expect(add.statusCode).toBe(404);
    expect(JSON.parse(add.body).error).toBe('unknown_player');
  });
});
