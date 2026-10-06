// CONTRACT (PR-219 round-3 review, P1): a SAVE into an account the editor did not load —
// a recovered pending bootstrap, a cross-tab adoption, a fresh deploy — must not wipe the
// profile that account already holds. The editor's baseline there is a PLACEHOLDER, so
// only a field the player actually CHANGED from it may speak; an untouched field carries
// the account's stored value forward verbatim.
// AND it must not SWAP the face (the username is decided locally, then deployed — root
// AGENTS.md #216): an account that was NEVER CUSTOMIZED (the 404, a fresh mint above all)
// stores what the player was SHOWN — the canvas's mark and the line's name, the seed's pair
// where untouched — the same pair every other deploy button stores. The EMPTY value would
// draw the new account id's face instead, one the player never saw.

import { describe, expect, it } from 'vitest';
import { anonName, blankAvatar, defaultAvatar } from '@whippin/shared';
import { guardedSaveBody } from './Profile';

const SEED = 'aaaaaaaaaaaaaaaa';
const baseline = { name: anonName(SEED), avatar: defaultAvatar(SEED) };
const server = { name: 'Chqrles', avatar: blankAvatar(2) };

describe('guardedSaveBody — a placeholder baseline may not wipe a real profile', () => {
  it('changing only the NAME keeps the stored custom avatar', () => {
    const body = guardedSaveBody(
      { name: 'NewName', avatar: baseline.avatar },
      baseline,
      SEED,
      server,
    );
    expect(body).toEqual({ name: 'NewName', avatar: server.avatar });
  });

  it('changing only the AVATAR keeps the stored custom name', () => {
    const drawn = blankAvatar(4);
    const body = guardedSaveBody({ name: baseline.name, avatar: drawn }, baseline, SEED, server);
    expect(body).toEqual({ name: server.name, avatar: drawn });
  });

  it('an untouched field over a stored EMPTY value stays empty — no placeholder leaks in', () => {
    const body = guardedSaveBody(
      { name: 'NewName', avatar: baseline.avatar },
      baseline,
      SEED,
      { name: '', avatar: null },
    );
    // The stored null avatar round-trips as the empty store value, never as the SEED's
    // generated grid (the display-only rule, both directions).
    expect(body).toEqual({ name: 'NewName', avatar: '' });
  });

  it('a changed field equal to the SHOWN assigned value still stores as empty', () => {
    // On an account that stores a row, the store-halves compare against what the player was
    // shown (`assignedFrom`), so a name deliberately typed back to the placeholder pseudonym
    // stores as '' — the name rule's one accepted cost, unchanged by the guard.
    const body = guardedSaveBody(
      { name: baseline.name, avatar: baseline.avatar },
      { name: 'other', avatar: blankAvatar(3) },
      SEED,
      server,
    );
    expect(body).toEqual({ name: '', avatar: '' });
  });
});

describe('guardedSaveBody — a NEVER CUSTOMIZED account stores the face the player was shown', () => {
  it('changing only the NAME keeps the SEED\u2019s mark — never the new id\u2019s', () => {
    const body = guardedSaveBody({ name: 'NewName', avatar: baseline.avatar }, baseline, SEED, null);
    expect(body).toEqual({ name: 'NewName', avatar: defaultAvatar(SEED) });
  });

  it('changing only the MARK keeps the SEED\u2019s pseudonym — the same pair PLAY stores', () => {
    const drawn = blankAvatar(1);
    const body = guardedSaveBody({ name: baseline.name, avatar: drawn }, baseline, SEED, null);
    expect(body).toEqual({ name: anonName(SEED), avatar: drawn });
  });

  it('an EMPTIED name stores the pseudonym the line showed in its place', () => {
    const body = guardedSaveBody({ name: '', avatar: baseline.avatar }, baseline, SEED, null);
    expect(body).toEqual({ name: anonName(SEED), avatar: defaultAvatar(SEED) });
  });

  it('nothing in the body is ever the empty value', () => {
    const drawn = blankAvatar(4);
    for (const edited of [
      { name: baseline.name, avatar: baseline.avatar },
      { name: 'Zoe', avatar: drawn },
      { name: '', avatar: drawn },
    ]) {
      const body = guardedSaveBody(edited, baseline, SEED, null);
      expect(body.name).not.toBe('');
      expect(body.avatar).not.toBe('');
    }
  });
});
