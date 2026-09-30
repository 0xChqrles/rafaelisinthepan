// When the player's OWN face is read (`useOwnFace`). `GET /profile` stays the only source of
// the face; the two writers of this device's profile only SIGNAL, and never hand the face a
// value of their own:
//   - a bumped `revision` re-reads the face, the one already drawn standing meanwhile: the
//     profile editor bumps it after a successful SAVE, `localIdentityDeploy` when its flight
//     settles, whatever the outcome;
//   - `firstWrites` counts the FIRST profiles of accounts being written (the deploy's
//     flight, or the editor's SAVE that minted the account): a MINTED account's face is not
//     read while one is out, since the read would find no profile yet and settle on the face
//     of the new account id, which nobody chose.
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
