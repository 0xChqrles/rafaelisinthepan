// CONTRACT: the paths three packages agree on (shared/src/invite.ts). A SIGNED share
// (user-decided 2026-09-05) is the plain share path plus ONE segment, so the plain link
// is the signed one minus it, byte for byte, and the token itself never changes.

import { describe, expect, it } from 'vitest';
import {
  SHARE_TOKEN_SOURCE,
  groupCardPath,
  groupInvitePath,
  groupLandingPath,
  shareCardPath,
  sharePath,
} from './invite';

const ID = 'abcdefghij234567';
const TOKEN = 'BqN_lM-9';

describe('share and invite paths', () => {
  it('a plain share is /s/<token>; the signature is a second segment', () => {
    expect(sharePath(TOKEN)).toBe(`/s/${TOKEN}`);
    expect(sharePath(TOKEN, null)).toBe(`/s/${TOKEN}`);
    expect(sharePath(TOKEN, ID)).toBe(`/s/${TOKEN}/${ID}`);
  });

  it('the card follows the same rule', () => {
    expect(shareCardPath(TOKEN)).toBe(`/og/${TOKEN}.png`);
    expect(shareCardPath(TOKEN, ID)).toBe(`/og/${TOKEN}/${ID}.png`);
  });

  it('the group invite link, its landing and its card (#271)', () => {
    expect(groupInvitePath(ID)).toBe(`/g/${ID}`);
    expect(groupLandingPath(ID)).toBe(`/join/g/${ID}`);
    expect(groupCardPath(ID)).toBe(`/og/g/${ID}.png`);
  });

  it('a token never contains a slash, which is what keeps the two segments apart', () => {
    const whole = new RegExp(`^${SHARE_TOKEN_SOURCE}$`);
    expect(whole.test(TOKEN)).toBe(true);
    expect(whole.test(`${TOKEN}/${ID}`)).toBe(false);
    expect(whole.test('')).toBe(false);
  });
});
