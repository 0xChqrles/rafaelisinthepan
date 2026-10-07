// CONTRACT (root AGENTS.md, Email account linking): the server branches only AFTER the code
// is verified, and BINDS an unknown address "only with `bind` consent — the RETURNING door
// never binds" (without it the answer is 404 `no_account`). The server obeys the flag, so
// the door's own body is the one place that rule is kept: SAVE authorizes the bind, RETURN
// never does, and the two confirmations (`erase`, `leave`) travel beside it unchanged.

import { describe, expect, it } from 'vitest';
import { AVATAR_SIZE } from '@whippin/shared';
import { FLOW_FACE_PX, readVerifyAnswer, verifyBody } from './AccountEmail';

const TOKEN = 'f'.repeat(64);
const EMAIL = 'player@example.com';
const CODE = '123456';

describe('verifyBody — what each door authorizes', () => {
  it('the SAVE door verifies with the bind consent', () => {
    expect(verifyBody(TOKEN, EMAIL, CODE, false)).toEqual({ token: TOKEN, email: EMAIL, code: CODE, bind: true });
  });

  it('the RETURNING door never binds', () => {
    expect(verifyBody(TOKEN, EMAIL, CODE, true)).toEqual({ token: TOKEN, email: EMAIL, code: CODE, bind: false });
  });

  it('a confirmation names the account being left and changes nothing about the bind', () => {
    expect(verifyBody(TOKEN, EMAIL, CODE, true, { erase: 'aaaaaaaaaaaaaaaa' })).toEqual({
      token: TOKEN,
      email: EMAIL,
      code: CODE,
      bind: false,
      erase: 'aaaaaaaaaaaaaaaa',
    });
    expect(verifyBody(TOKEN, EMAIL, CODE, false, { leave: 'bbbbbbbbbbbbbbbb' })).toEqual({
      token: TOKEN,
      email: EMAIL,
      code: CODE,
      bind: true,
      leave: 'bbbbbbbbbbbbbbbb',
    });
  });
});

// The flow's faces are pixel marks at WHOLE-PIXEL scales (the profile-area direction): a
// cell is a whole number of CSS pixels, so the traced mark, the churning canvas and the
// step-up between them land on the pixel grid — and the ending, the screen's one subject,
// is the largest of them, the lead's own mark stepped forward.
describe('the flow faces', () => {
  it('are drawn at a whole number of pixels a cell', () => {
    for (const size of Object.values(FLOW_FACE_PX)) expect(size % AVATAR_SIZE).toBe(0);
  });

  it('step FORWARD from the lead to the ending', () => {
    expect(FLOW_FACE_PX.ending).toBeGreaterThan(FLOW_FACE_PX.lead);
    expect(FLOW_FACE_PX.lead).toBeGreaterThan(FLOW_FACE_PX.cross);
  });
});

// CONTRACT (root AGENTS.md, the live routes): a client acts on the error CODE, never on the
// status alone, and a 5xx, a transport failure or an unparseable body is NEVER a verdict.
// What a verify's answer means decides where the flow answers it: a verdict on the CODE on
// the code step, a fact about the ADDRESS at its field, and an UNKNOWN outcome — read again
// first — on the error surface, never as a line telling the player to type the code again.
describe('readVerifyAnswer — what a verify answered', () => {
  const LEFT = 'aaaaaaaaaaaaaaaa';
  const JOINED = 'bbbbbbbbbbbbbbbb';

  it('a link it can read is linked; one it cannot is unknown, never a failure verdict', () => {
    const body = { outcome: 'adopted', accountId: JOINED, deviceId: LEFT, email: EMAIL, departurePending: false };
    expect(readVerifyAnswer(200, body)).toMatchObject({ kind: 'linked', result: { outcome: 'adopted' } });
    expect(readVerifyAnswer(200, { ...body, departurePending: undefined })).toEqual({ kind: 'unknown' });
    expect(readVerifyAnswer(200, null)).toEqual({ kind: 'unknown' });
  });

  it('a confirmation naming the account being left is the crossroads', () => {
    expect(readVerifyAnswer(409, { error: 'would_erase', accountId: LEFT, target: JOINED })).toMatchObject({
      kind: 'confirm',
      prompt: { kind: 'erase', accountId: LEFT, target: JOINED },
    });
    expect(readVerifyAnswer(409, { error: 'would_switch', accountId: LEFT })).toMatchObject({
      kind: 'confirm',
      prompt: { kind: 'switch', accountId: LEFT },
    });
  });

  it('a confirmation naming no account is UNKNOWN — the same code would only get it again', () => {
    expect(readVerifyAnswer(409, { error: 'would_erase' })).toEqual({ kind: 'unknown' });
    expect(readVerifyAnswer(409, { error: 'would_switch', accountId: 'not-an-id' })).toEqual({ kind: 'unknown' });
  });

  it('the code verdicts', () => {
    expect(readVerifyAnswer(401, { error: 'bad_code', attemptsLeft: 3 })).toEqual({
      kind: 'wrong',
      attemptsLeft: 3,
      exhausted: false,
    });
    expect(readVerifyAnswer(401, { error: 'bad_code', attemptsLeft: 0 })).toEqual({
      kind: 'wrong',
      attemptsLeft: 0,
      exhausted: true,
    });
    expect(readVerifyAnswer(410, { error: 'code_expired' })).toEqual({ kind: 'dead', line: 'linkCodeExpired' });
    expect(readVerifyAnswer(404, { error: 'no_code' })).toEqual({ kind: 'dead', line: 'linkCodeExpired' });
    expect(readVerifyAnswer(409, { error: 'code_spent' })).toEqual({ kind: 'dead', line: 'linkCodeSpent' });
  });

  it('the facts about the address', () => {
    expect(readVerifyAnswer(404, { error: 'no_account' })).toEqual({ kind: 'address', note: 'linkNoAccountThere' });
    expect(readVerifyAnswer(409, { error: 'account_linked' })).toEqual({ kind: 'address', note: 'linkAlreadySaved' });
  });

  it('only 401 unknown_device signs the device out', () => {
    expect(readVerifyAnswer(401, { error: 'unknown_device' })).toEqual({ kind: 'signedOut' });
    expect(readVerifyAnswer(403, { error: 'unknown_device' })).toEqual({ kind: 'unknown' });
  });

  it('a 5xx, a body with no code to read, or a code it does not know is UNKNOWN', () => {
    expect(readVerifyAnswer(503, { error: 'code_expired' })).toEqual({ kind: 'unknown' });
    expect(readVerifyAnswer(500, null)).toEqual({ kind: 'unknown' });
    expect(readVerifyAnswer(409, null)).toEqual({ kind: 'unknown' });
    expect(readVerifyAnswer(400, {})).toEqual({ kind: 'unknown' });
    expect(readVerifyAnswer(400, { error: 'something_new' })).toEqual({ kind: 'unknown' });
  });
});
