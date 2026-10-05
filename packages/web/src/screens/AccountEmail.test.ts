// CONTRACT (root AGENTS.md, Email account linking): the server branches only AFTER the code
// is verified, and BINDS an unknown address "only with `bind` consent — the RETURNING door
// never binds" (without it the answer is 404 `no_account`). The server obeys the flag, so
// the door's own body is the one place that rule is kept: SAVE authorizes the bind, RETURN
// never does, and the two confirmations (`erase`, `leave`) travel beside it unchanged.

import { describe, expect, it } from 'vitest';
import { AVATAR_SIZE } from '@whippin/shared';
import { FLOW_FACE_PX, verifyBody } from './AccountEmail';

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
