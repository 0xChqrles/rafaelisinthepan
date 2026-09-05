// CONTRACT: the paths three packages agree on (shared/src/invite.ts). A SIGNED share
// (user-decided 2026-09-05) is the plain share path plus ONE segment, so that the toggle
// OFF yields today's link byte for byte and the token itself never changes.

import { describe, expect, it } from 'vitest';
import {
  SHARE_TOKEN_PATTERN,
  inviteCardPath,
  inviteLandingPath,
  invitePath,
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

  it('the signed landing is the invite landing carrying the token', () => {
    expect(inviteLandingPath(ID)).toBe(`/join/${ID}`);
    expect(inviteLandingPath(ID, TOKEN)).toBe(`/join/${ID}/${TOKEN}`);
    expect(invitePath(ID)).toBe(`/i/${ID}`);
    expect(inviteCardPath(ID)).toBe(`/og/i/${ID}.png`);
  });

  it('a token never contains a slash, which is what keeps the two segments apart', () => {
    expect(SHARE_TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(SHARE_TOKEN_PATTERN.test(`${TOKEN}/${ID}`)).toBe(false);
    expect(SHARE_TOKEN_PATTERN.test('')).toBe(false);
  });
});
