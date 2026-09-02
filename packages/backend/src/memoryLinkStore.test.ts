import { describe, expect, it } from 'vitest';
import { LINK_CODE_MAX_ATTEMPTS } from '@whippin/shared';
import { memoryLinkStore } from './memoryLinkStore';
import type { LinkChallenge } from './linkStore';

// CONTRACT: the memory store answers like the production one. It is the store
// `backend:dev` and every route test runs on, so a rule it spells differently is a rule
// those tests cannot see — the memory ROUND store's own reason for having a suite.

const HASH = 'e'.repeat(64);
const NOW = new Date('2026-08-26T12:00:00.000Z');
const RIGHT = 'c'.repeat(64);
const WRONG = 'd'.repeat(64);

function store() {
  return memoryLinkStore({
    devices: {
      bindAccountEmail: () => true,
      adoptDevice: () => 'adopted',
    },
    profiles: { remove: () => undefined },
    rounds: { move: () => null },
    scores: { move: () => undefined },
  });
}

const challenge = (): LinkChallenge => ({
  codeHash: RIGHT,
  attempts: 0,
  createdAt: NOW.toISOString(),
  expiresAt: Math.floor(NOW.getTime() / 1_000) + 600,
});

describe('memoryLinkStore.verify — the attempt ladder (#204)', () => {
  // A COUNTED mismatch is `wrong`, the LAST one included, with nothing left. `spent` is
  // what the NEXT call gets. Calling the fifth mismatch `spent` answered a 409 for a code
  // the player actually typed wrong, and left the screen unable to say how it ended.
  it('answers attempts 1 through 5 `wrong` — counting down to ZERO — and the sixth `spent`', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());

    const seen = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      seen.push(await links.verify(HASH, WRONG, NOW));
    }
    expect(seen).toEqual([
      { outcome: 'wrong', attemptsLeft: 4 },
      { outcome: 'wrong', attemptsLeft: 3 },
      { outcome: 'wrong', attemptsLeft: 2 },
      { outcome: 'wrong', attemptsLeft: 1 },
      { outcome: 'wrong', attemptsLeft: 0 },
      { outcome: 'spent', attemptsLeft: 0 },
    ]);
    expect(LINK_CODE_MAX_ATTEMPTS).toBe(5);
  });

  it('spends NO attempt on a correct code — one successful link verifies twice', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(links.verify(HASH, RIGHT, NOW)).resolves.toEqual({
        outcome: 'ok',
        attemptsLeft: LINK_CODE_MAX_ATTEMPTS,
      });
    }
  });

  it('answers an exhausted challenge `spent` even for the RIGHT code', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    for (let attempt = 0; attempt < LINK_CODE_MAX_ATTEMPTS; attempt += 1) {
      await links.verify(HASH, WRONG, NOW);
    }
    await expect(links.verify(HASH, RIGHT, NOW)).resolves.toEqual({
      outcome: 'spent',
      attemptsLeft: 0,
    });
  });

  it('a RESEND replaces the challenge, attempts and all', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    await links.verify(HASH, WRONG, NOW);
    await links.putChallenge(HASH, challenge());
    await expect(links.verify(HASH, WRONG, NOW)).resolves.toEqual({
      outcome: 'wrong',
      attemptsLeft: LINK_CODE_MAX_ATTEMPTS - 1,
    });
  });
});

describe('memoryLinkStore.binding (#204)', () => {
  it('answers WHICH account an address reaches, and nothing else', async () => {
    const links = store();
    await links.putChallenge(HASH, challenge());
    await expect(
      links.bind({
        emailHash: HASH,
        codeHash: RIGHT,
        email: 'zoe@example.com',
        accountId: 'aaaaaaaaaaaaaaaa',
        now: NOW.toISOString(),
      }),
    ).resolves.toBe('bound');
    // A binding carries the account id ALONE — the `createdAt` it used to hold was read by
    // nothing, and an attribute nothing reads is a field that drifts (PR-227 review).
    await expect(links.binding(HASH)).resolves.toEqual({ accountId: 'aaaaaaaaaaaaaaaa' });
  });
});
