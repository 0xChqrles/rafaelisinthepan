// CONTRACT (root AGENTS.md, Email account linking): the server branches only AFTER the code
// is verified, and BINDS an unknown address "only with `bind` consent — the RETURNING door
// never binds" (without it the answer is 404 `no_account`). The server obeys the flag, so
// the door's own body is the one place that rule is kept: SAVE authorizes the bind, RETURN
// never does, and the two confirmations (`erase`, `leave`) travel beside it unchanged.

import { describe, expect, it } from 'vitest';
import { verifyBody } from './AccountEmail';

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
