// When the player's OWN face is read (`useOwnFace`). `GET /profile` stays the only source of
// the face; the two writers of this device's profile only SIGNAL, and never hand the face a
// value of their own:
//   - a bumped `revision` re-reads the face, the one already drawn standing meanwhile: the
//     profile editor bumps it after a successful SAVE, `localIdentityDeploy` when its flight
//     settles, whatever the outcome, and a RETRY after a read that failed (the masthead's
//     mark, the header's key when the tab comes back);
//   - `firstWrites` counts the FIRST profiles of accounts being written (the deploy's
//     flight, or the editor's SAVE that minted the account): a MINTED account's face is not
//     read while one is out, since the read would find no profile yet and settle on the face
//     of the new account id, which nobody chose — nor does the profile editor read what the
//     account stores (`firstWritesSettled`).
//
// TRANSIENT: counters about writes in flight in this tab, never persisted.

import { create } from 'zustand';

interface OwnFaceSignal {
  firstWrites: number;
  revision: number;
}

export const useOwnFaceSignal = create<OwnFaceSignal>(() => ({ firstWrites: 0, revision: 0 }));

// The profile was written: the face reads it again.
export function ownProfileWritten(): void {
  useOwnFaceSignal.setState((s) => ({ revision: s.revision + 1 }));
}

// Resolves once no account's first profile is being written in this tab. Until then the
// account's stored profile is about to change, and a read of it would find no row yet: the
// profile editor's reads of what the account stores wait on it.
export function firstWritesSettled(): Promise<void> {
  return new Promise((resolve) => {
    if (useOwnFaceSignal.getState().firstWrites === 0) {
      resolve();
      return;
    }
    const stop = useOwnFaceSignal.subscribe((s) => {
      if (s.firstWrites > 0) return;
      stop();
      resolve();
    });
  });
}

// The face's read FAILED and it is asked again (the masthead's held mark, the tab coming
// back): the same re-read, no write behind it.
export const retryOwnFace = ownProfileWritten;

// An account's first profile is being written; the answer releases it. `written` also
// bumps the revision, in the SAME state change, so the face's one read follows both.
export function holdOwnFace(): (written: boolean) => void {
  useOwnFaceSignal.setState((s) => ({ firstWrites: s.firstWrites + 1 }));
  let released = false;
  return (written) => {
    if (released) return;
    released = true;
    useOwnFaceSignal.setState((s) => ({
      firstWrites: s.firstWrites - 1,
      revision: written ? s.revision + 1 : s.revision,
    }));
  };
}
