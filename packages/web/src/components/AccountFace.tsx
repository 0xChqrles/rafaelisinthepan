// WHO an account is, on screen: its mark and its name (#204's UX rework).
//
// Three surfaces draw exactly this — the account screen's summary, the email flow's ending
// ("we found your account" is a claim only a FACE can make), and the signed-out screen's
// "here is what you are leaving" — and each of them used to fetch it themselves. The read
// is the invite landing's: a public GET, a short timeout, and the ASSIGNED identity when
// the profile never existed or the read failed.
//
// **It resolves to nothing until it has settled, and it is TAGGED with the account it is
// about.** Publishing the assigned identity early and correcting it a beat later showed
// every named player a stranger's name under their own mark (the leaderboard strip's own
// finding, 2026-08-20) — and a component that is not remounted when its account changes
// keeps rendering the previous face until the next read lands, which on the one screen
// whose job is naming an identity is the wrong person entirely.

import { useEffect, useState } from 'react';
import { anonName } from '@whippin/shared';
import { parseProfile, profileUrl } from '../api';
import { useDeviceIdentity } from '../identity';
import { useGameStore } from '../state/gameStore';
import { timeoutSignal } from '../timeout';

// How long a decorative read may hold a screen before its fallback stands in. Spent
// through `timeoutSignal`, never `AbortSignal.timeout()` — the rule and its reason live in
// `timeout.ts`, and here it would take the face off every screen of the account area.
const FACE_TIMEOUT_MS = 6_000;

export interface Face {
  publicId: string;
  name: string;
  avatar: string | null;
}

// The account's face, or null while the read is still out. `local` is the TOKENLESS case:
// the id is a placeholder seed no account exists for, so there is nothing to ask about and
// the assigned identity IS the answer — settled immediately, never a breathing promise.
export function useAccountFace(publicId: string | null, local = false): Face | null {
  const [face, setFace] = useState<Face | null>(null);

  useEffect(() => {
    if (publicId === null) {
      setFace(null);
      return;
    }
    if (local) {
      setFace({ publicId, name: anonName(publicId), avatar: null });
      return;
    }
    let mounted = true;
    (async () => {
      let shown: Face = { publicId, name: anonName(publicId), avatar: null };
      try {
        const response = await fetch(profileUrl(publicId), {
          signal: timeoutSignal(FACE_TIMEOUT_MS),
        });
        if (response.ok) {
          const profile = parseProfile(await response.json());
          shown = { publicId, name: profile.name || anonName(publicId), avatar: profile.avatar };
        }
        // A 404 is "never customized" and a 410 is "gone" (#204) — both keep the assigned
        // fallback here, because this component only ever draws an account its caller
        // already believes in.
      } catch {
        // Keep the fallback.
      }
      if (mounted) setFace(shown);
    })();
    return () => {
      mounted = false;
    };
  }, [publicId, local]);

  // Never a face belonging to a PREVIOUS account: a caller that is not remounted would
  // otherwise render the wrong person for as long as the new read takes.
  return face?.publicId === publicId ? face : null;
}

// THE FACE THIS DEVICE WEARS, whether or not it has an account yet — and the reason the
// account screens cannot tell you which (user-decided 2026-08-26). A deployed device reads
// its account's public profile; a tokenless one derives the SAME pair from the persisted
// local seed (`gameStore.localSeed`), which is exactly what `localIdentityDeploy` stores as
// the account's first profile the moment one is created. So the face before deployment and
// the face after it are the same face, and no screen has to branch on a status the player
// should never be shown.
export function useOwnFace(): Face | null {
  const identity = useDeviceIdentity();
  const localSeed = useGameStore((s) => s.localSeed);
  const ensureLocalSeed = useGameStore((s) => s.ensureLocalSeed);

  // The placeholder the leaderboard strip already shows, minted on first need so the two
  // surfaces can never show one visitor two faces.
  useEffect(() => {
    if (identity === null && localSeed === null) ensureLocalSeed();
  }, [identity, localSeed, ensureLocalSeed]);

  return useAccountFace(identity?.accountId ?? localSeed, identity === null);
}
