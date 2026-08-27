import { describe, expect, it } from 'vitest';
import { activeDate, dayNumber, LINK_SENDS_PER_ADDRESS } from '@whippin/shared';
import { FRIENDS_MAX } from './friendStore';
import { createHandler } from './handler';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryFriendStore } from './memoryFriendStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryLinkStore } from './memoryLinkStore';
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

function harness() {
  const devices = memoryDeviceStore();
  const profiles = memoryProfileStore((id) => devices.accountExists(id));
  const friends = memoryFriendStore();
  const rounds = memoryRoundStore();
  const scores = memoryScoreStore(() => NOW);
  const history = memoryHistoryStore();
  const links = memoryLinkStore({ devices, profiles });
  const sent: MailMessage[] = [];
  const handler = createHandler({
    store: emptyStore,
    now: () => NOW,
    scores: { scoreStore: scores },
    profiles,
    friends,
    deviceStore: devices,
    devices: { turnstile: { verify: async () => true }, allowSourceIp: true },
    link: {
      links,
      friends,
      rounds,
      scores,
      history,
      mailer: {
        async send(message) {
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

  it('answers a code nobody asked for as a missing challenge, not a wrong one', async () => {
    const h = harness();
    const me = await seedDevice(h.devices);
    const answer = await h.handler(post({ token: me.token, email: 'zoe@example.com', code: '000000' }));
    expect(answer.statusCode).toBe(404);
    expect(JSON.parse(answer.body).error).toBe('no_code');
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
      erased: fresh.accountId,
    });
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
});

describe('email account linking (#204) — the erase confirmation', () => {
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
      stakes: { streak: expect.any(Number), days: expect.any(Number) },
    });
    await expect(h.devices.accountExists(playing.accountId)).resolves.toBe(false);
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
    // is not an orphan: nothing is destroyed, nothing transfers, and no dialog is needed.
    const answer = await h.handler(
      post({ token: b.token, email: 'a@example.com', code: await askForCode(h, b.token, 'a@example.com') }),
    );
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      outcome: 'adopted',
      accountId: a.accountId,
      erased: null,
      moved: 0,
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
    expect(JSON.parse(answer.body).moved).toBe(1);

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
    expect(JSON.parse(answer.body).moved).toBe(0);
    await expect(h.rounds.get(key, saved.accountId, 'rev1')).resolves.toMatchObject({
      guesses: ['souris'],
    });
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
