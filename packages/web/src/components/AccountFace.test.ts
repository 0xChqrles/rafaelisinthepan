// CONTRACT (#204, corrected on the PR-227 follow-up review): this hook is the ONE read of
// "who an account is", and a DELETED account has no face — not even the assigned pseudonym
// and mark, which are still that player's own. It used to dress a 410 `account_gone` exactly
// like a 404, on the reasoning that every caller already believes in the account it asks
// about; the email flow's crossroads draws `target`, an account this device does not own,
// and a locally cached token outlives another device's adoption, so that reasoning was false.
//
// THREE states, not two: `null` while the read is out, `'gone'` settled with nothing to
// draw, and a face. The difference is what stops a caller breathing a skeleton over an
// arrival that is not coming (#211's loading rule).

import { describe, expect, it, vi } from 'vitest';
import { anonName } from '@whippin/shared';

vi.mock('../api', () => ({ readProfile: vi.fn() }));
vi.mock('../identity', () => ({ useDeviceIdentity: () => null }));
vi.mock('../state/gameStore', () => ({ useGameStore: () => null }));

const { faceFromRead, faceSettled, shownFace } = await import('./AccountFace');

const ID = 'lfd5pqz5pa7zjm5u';
const FACE = { publicId: ID, name: 'Zoe', avatar: null };

describe('shownFace / faceSettled — the three states of an account face', () => {
  it('a read still OUT draws nothing and has not settled: the caller holds its box', () => {
    expect(shownFace(null)).toBeNull();
    expect(faceSettled(null)).toBe(false);
  });

  it('a DELETED account draws nothing but HAS settled — no shimmer over an absent player', () => {
    expect(shownFace('gone')).toBeNull();
    expect(faceSettled('gone')).toBe(true);
  });

  it('a face is drawn, and is settled', () => {
    expect(shownFace(FACE)).toEqual(FACE);
    expect(faceSettled(FACE)).toBe(true);
  });
});

// The mapping itself, one answer at a time — so a 404 and a 410 can never collapse back
// together.
describe('faceFromRead — what each profile answer means to a face', () => {
  it('a DELETED account has NO face, not even the assigned one', () => {
    // The whole finding: the assigned pair is still that player's own, so there is nothing
    // safe to fall back to — the caller must draw nothing at all.
    expect(faceFromRead({ status: 'gone' }, ID)).toBeNull();
  });

  it('a stored profile is the face, with the pseudonym standing in for an empty name', () => {
    expect(
      faceFromRead({ status: 'shown', profile: { publicId: ID, name: 'Zoe', avatar: null } }, ID),
    ).toEqual(FACE);
    expect(
      faceFromRead({ status: 'shown', profile: { publicId: ID, name: '', avatar: null } }, ID),
    ).toEqual({ publicId: ID, name: anonName(ID), avatar: null });
  });

  it('a 404 and a FAILED read both keep the assigned identity — neither is a deletion', () => {
    const assigned = { publicId: ID, name: anonName(ID), avatar: null };
    expect(faceFromRead({ status: 'blank' }, ID)).toEqual(assigned);
    expect(faceFromRead({ status: 'failed' }, ID)).toEqual(assigned);
  });
});
