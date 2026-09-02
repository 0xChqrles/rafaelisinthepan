// CONTRACT (#216 + #204): this screen names the account the device is being asked to
// leave — and it is the screen most likely to be naming a DELETED one, since an email link
// deletes the account it moved a device off and every other device on it lands here on its
// next private call. `GET /profile` answers 410 `account_gone` for one, and the assigned
// pseudonym and mark are NOT a safe fallback to it: they are still that player's own face.
//
// Three states, kept apart: not settled yet (the screen holds its frame), settled with a
// face, settled with NOTHING to draw. A read that merely FAILED is not a deletion.

import { describe, expect, it, vi } from 'vitest';
import { anonName } from '@whippin/shared';

vi.mock('../api', () => ({ readProfile: vi.fn() }));
vi.mock('../components/Avatar', () => ({ default: () => null }));
vi.mock('../components/Button', () => ({ default: () => null }));
vi.mock('../components/LoadingWave', () => ({ default: () => null }));
vi.mock('../identity', () => ({
  startFreshDevice: vi.fn(),
  useSignedOutAccount: () => null,
}));
vi.mock('../routing', () => ({ navigate: vi.fn() }));

const { faceFrom } = await import('./SignedOut');

const ACCOUNT = 'lfd5pqz5pa7zjm5u';

describe('faceFrom — what each profile answer means on the sign-out screen', () => {
  it('a DELETED account settles with NO face — never the assigned one, which is still theirs', () => {
    expect(faceFrom({ status: 'gone' }, ACCOUNT)).toEqual({ publicId: ACCOUNT, shown: null });
  });

  it('a stored profile is the face, with the pseudonym standing in for an empty name', () => {
    expect(
      faceFrom(
        { status: 'shown', profile: { publicId: ACCOUNT, name: 'Zoe', avatar: null } },
        ACCOUNT,
      ),
    ).toEqual({ publicId: ACCOUNT, shown: { name: 'Zoe', avatar: null } });
    expect(
      faceFrom({ status: 'shown', profile: { publicId: ACCOUNT, name: '', avatar: null } }, ACCOUNT),
    ).toEqual({ publicId: ACCOUNT, shown: { name: anonName(ACCOUNT), avatar: null } });
  });

  it('a 404 and a FAILED read both keep the assigned identity, and both SETTLE', () => {
    // Settling is the point: the screen holds a LoadingWave until the face is tagged with
    // this account, so a read that never resolved to anything would strand the player on a
    // loading frame with no way to reconnect or start fresh.
    const assigned = { publicId: ACCOUNT, shown: { name: anonName(ACCOUNT), avatar: null } };
    expect(faceFrom({ status: 'blank' }, ACCOUNT)).toEqual(assigned);
    expect(faceFrom({ status: 'failed' }, ACCOUNT)).toEqual(assigned);
  });
});
