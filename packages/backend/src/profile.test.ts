import { describe, expect, it } from 'vitest';
import { AVATAR_CELLS, blankAvatar, encodeAvatar, NAME_MAX_LENGTH } from '@whippin/shared';
import { createHandler } from './handler';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryProfileStore } from './memoryProfileStore';
import type { FnUrlEvent } from './respond';
import type { PuzzleStore } from './store';
import { seedDevice } from './testDevice';

const emptyStore: PuzzleStore = {
  getPuzzle: async () => null,
  getWordPuzzle: async () => null,
  getSlice: async () => null,
};

async function makeHandler(profiles = memoryProfileStore()) {
  const devices = memoryDeviceStore();
  return {
    profiles,
    handler: createHandler({
      store: emptyStore,
      profiles,
      devices: {
        deviceStore: devices,
        turnstile: { verify: async () => true },
        allowSourceIp: true,
      },
    }),
    // Two devices on two ACCOUNTS: the profile is the account's, so writing from one must
    // never be visible under the other's id.
    me: await seedDevice(devices),
    other: await seedDevice(devices),
  };
}

function get(id: string | undefined): FnUrlEvent {
  return {
    rawPath: '/profile',
    queryStringParameters: id === undefined ? {} : { id },
    requestContext: { http: { method: 'GET' } },
  };
}

function post(body: unknown): FnUrlEvent {
  return {
    rawPath: '/profile',
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
  };
}

// A 10×10 with a swastika drawn in ink 1 (the detector's own fixture shape).
function swastikaAvatar(): string {
  const rows = ['X.XXX', 'X.X..', 'XXXXX', '..X.X', 'XXX.X'];
  const cells = new Array<number>(AVATAR_CELLS).fill(0);
  rows.forEach((row, r) => {
    [...row].forEach((char, c) => {
      if (char === 'X') cells[r * 10 + c] = 1;
    });
  });
  return encodeAvatar(0, cells);
}

describe('profile route (#188)', () => {
  it("writes the row keyed by the CALLER's account and reads it back", async () => {
    const { handler, me } = await makeHandler();
    const avatar = blankAvatar(1);
    const posted = await handler(post({ token: me.token, name: 'Chqrles', avatar }));
    expect(posted.statusCode).toBe(200);
    const publicId = me.accountId;
    // The response carries the resolved account and the name VERBATIM — never the device
    // token, and never a name the server quietly rewrote (the shared rule refuses a
    // non-conforming one instead, below).
    expect(JSON.parse(posted.body)).toEqual({ publicId, name: 'Chqrles', avatar });
    expect(posted.body).not.toContain(me.token);
    expect(posted.headers['Cache-Control']).toBe('no-store');

    const read = await handler(get(publicId));
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.body)).toEqual({ publicId, name: 'Chqrles', avatar });
  });

  it("accepts the EMPTY avatar as \"no custom mark\" and stores it verbatim", async () => {
    // The editor's WRITE half (PR-219 round-2 review): a drawing still equal to the
    // assigned mark it opened on stores as '' — never a generated grid frozen into the
    // row — so every reader keeps deriving the face from the account id (the board and
    // the invite preview already dress '' as null). Nothing to decode, nothing to
    // moderate.
    const { handler, me } = await makeHandler();
    const posted = await handler(post({ token: me.token, name: 'Chqrles', avatar: '' }));
    expect(posted.statusCode).toBe(200);
    const publicId = me.accountId;
    expect(JSON.parse(posted.body)).toEqual({ publicId, name: 'Chqrles', avatar: '' });
    const read = await handler(get(publicId));
    expect(JSON.parse(read.body)).toEqual({ publicId, name: 'Chqrles', avatar: '' });
  });

  it('upserts: a second write replaces name and avatar for the same identity', async () => {
    const { handler, me } = await makeHandler();
    await handler(post({ token: me.token, name: 'First', avatar: blankAvatar(0) }));
    const second = await handler(post({ token: me.token, name: 'Second', avatar: blankAvatar(2) }));
    expect(second.statusCode).toBe(200);
    const publicId = me.accountId;
    const read = await handler(get(publicId));
    expect(JSON.parse(read.body)).toEqual({
      publicId,
      name: 'Second',
      avatar: blankAvatar(2),
    });
  });

  it('two devices on two accounts are two identities', async () => {
    const { handler, me, other } = await makeHandler();
    await handler(post({ token: me.token, name: 'One', avatar: blankAvatar() }));
    await handler(post({ token: other.token, name: 'Two', avatar: blankAvatar() }));
    const one = await handler(get(me.accountId));
    const two = await handler(get(other.accountId));
    expect(JSON.parse(one.body).name).toBe('One');
    expect(JSON.parse(two.body).name).toBe('Two');
  });

  it('refuses a write without a canonical device token', async () => {
    const { handler } = await makeHandler();
    // Malformed is an INPUT error, never `unknown_device`: an uppercase spelling is
    // refused rather than normalized, or one token would key two rows.
    for (const token of [undefined, '', 'not-a-token', 'A'.repeat(64), 'a'.repeat(63)]) {
      const response = await handler(post({ token, name: 'x', avatar: blankAvatar() }));
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('bad_request');
    }
  });

  it('refuses a write from a device nobody holds with unknown_device (#216)', async () => {
    const { handler } = await makeHandler();
    const response = await handler(
      post({ token: 'f'.repeat(64), name: 'x', avatar: blankAvatar() }),
    );
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('unknown_device');
  });

  it('rejects every name the SHARED rule would change', async () => {
    const { handler, me } = await makeHandler();
    // The web can produce none of these: the charset rule is the shared one, so the
    // store only ever holds what the editor can. A caller going around it is refused,
    // never silently rewritten.
    const refused = [
      17, // not a string
      'x'.repeat(NAME_MAX_LENGTH + 1),
      'Big Chef', // whitespace
      ' Chqrles', // edge whitespace — there is no trim to save it any more
      'Jean-Luc', // punctuation
      'Éléonore', // an accent — the editor FOLDS it, and the server refuses the unfolded form
      'a\u0007c', // control character
      'a\u200Bc', // zero-width format character
      '\u0020'.repeat(16), // the invisible player a permissive rule used to allow
      '\u0301'.repeat(16), // a Zalgo stack of combining marks
      '😀',
    ];
    for (const name of refused) {
      const response = await handler(post({ token: me.token, name, avatar: blankAvatar() }));
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toBe('bad_request');
    }
    // Exactly the cap is fine, underscores are the one separator, and the empty name
    // is a valid avatar-only profile.
    for (const name of ['x'.repeat(NAME_MAX_LENGTH), 'jean_pierre', 'X4E9', '']) {
      const response = await handler(post({ token: me.token, name, avatar: blankAvatar() }));
      expect(response.statusCode).toBe(200);
    }
  });

  it('rejects a banned name with its own error code', async () => {
    const { handler, me } = await makeHandler();
    const response = await handler(
      post({ token: me.token, name: 'H1tl3r', avatar: blankAvatar() }),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('name_rejected');
  });

  it('rejects a malformed avatar and a swastika avatar', async () => {
    const { handler, me } = await makeHandler();
    const malformed = await handler(post({ token: me.token, name: 'x', avatar: 'nope' }));
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body).error).toBe('bad_request');

    const symbol = await handler(post({ token: me.token, name: 'x', avatar: swastikaAvatar() }));
    expect(symbol.statusCode).toBe(400);
    expect(JSON.parse(symbol.body).error).toBe('avatar_rejected');
  });

  it('a refused write stores nothing', async () => {
    const { handler, me } = await makeHandler();
    await handler(post({ token: me.token, name: 'nazi', avatar: blankAvatar() }));
    const read = await handler(get(me.accountId));
    expect(read.statusCode).toBe(404);
  });

  it('GET validates the id and 404s an unknown profile', async () => {
    const { handler } = await makeHandler();
    for (const id of [undefined, '', 'UPPER', 'short', '0'.repeat(16)]) {
      const response = await handler(get(id));
      expect(response.statusCode).toBe(400);
    }
    const unknown = await handler(get('abcdefghij234567'));
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses non-GET/POST methods and answers preflight', async () => {
    const { handler } = await makeHandler();
    const del = await handler({
      rawPath: '/profile',
      requestContext: { http: { method: 'DELETE' } },
    });
    expect(del.statusCode).toBe(405);
    const preflight = await handler({
      rawPath: '/profile',
      requestContext: { http: { method: 'OPTIONS' } },
    });
    expect(preflight.statusCode).toBe(204);
  });
});
