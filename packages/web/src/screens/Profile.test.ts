// CONTRACT (PR-219 round-3 review, P1): a SAVE into an account the editor did not load —
// a recovered pending bootstrap, a cross-tab adoption, a fresh deploy — must not wipe the
// profile that account already holds. The editor's baseline there is a PLACEHOLDER, so
// only a field the player actually CHANGED from it may speak; an untouched field carries
// the account's stored value forward verbatim. The 404 "never customized" applies the
// intended save in full, with the placeholder-untouched fields mapping to the EMPTY value
// every surface derives the assigned identity from.

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

  it('a 404 account takes the intended save in full, placeholder-untouched fields as empty', () => {
    const drawn = blankAvatar(1);
    const body = guardedSaveBody({ name: baseline.name, avatar: drawn }, baseline, SEED, null);
    // The untouched name is the SEED's pseudonym — never typed, stored as ''.
    expect(body).toEqual({ name: '', avatar: drawn });
  });

  it('a changed field equal to the SHOWN assigned value still stores as empty', () => {
    // The store-halves compare against what the player was shown (`assignedFrom`), so a
    // name deliberately typed back to the placeholder pseudonym stores as '' — the name
    // rule's one accepted cost, unchanged by the guard.
    const body = guardedSaveBody(
      { name: baseline.name, avatar: baseline.avatar },
      { name: 'other', avatar: blankAvatar(3) },
      SEED,
      null,
    );
    expect(body).toEqual({ name: '', avatar: '' });
  });
});
