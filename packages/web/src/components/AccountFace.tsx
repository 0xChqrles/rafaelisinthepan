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
//
// **A DELETED ACCOUNT SETTLES WITH NO FACE** (#204, corrected 2026-09-02 on the PR-227
// follow-up review). This dressed a 410 `account_gone` exactly like a 404, on the reasoning
// that every caller already believes in the account it asks about — which was FALSE: the
// email flow's crossroads draws `target`, an account this device does not own and only the
// server vouched for a moment earlier, and a locally cached token outlives another device's
// adoption, so `useOwnFace` can be asked about an account that was deleted seconds ago. The
// assigned pseudonym and mark are still that player's own face, so drawing them is drawing
// a deleted identity — the one thing #204's 410 exists to stop.
//
// So the answer is THREE states, not two: `null` while the read is out, `'gone'` for an
// account that no longer exists, and a face. `'gone' `is SETTLED — a caller holds its box
// for the read and then stops, because a placeholder that breathes forever with no request
// behind it is the false claim #211's loading rule forbids. `shownFace` and `faceSettled`
// are how a caller asks each question without restating the union.

import { useEffect, useState } from 'react';
import { anonName } from '@whippin/shared';
import { readProfile, type ProfileRead } from '../api';
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

// A settled read, TAGGED: `face: null` is the account being GONE, which is why the tag
// lives out here rather than on the face itself.
interface Settled {
  publicId: string;
  face: Face | null;
}

export type FaceState = Face | 'gone' | null;

// The face to DRAW, or null when there is none — the read is still out, or the account is
// gone. `faceSettled` is what tells those two apart.
export function shownFace(state: FaceState): Face | null {
  return state === null || state === 'gone' ? null : state;
}

// Has the read ANSWERED? A deleted account answers with nothing to draw, and a caller that
// keeps a skeleton breathing over it is promising an arrival that is not coming.
export function faceSettled(state: FaceState): boolean {
  return state !== null;
}

// A face slot breathes only while its read is genuinely pending. Keep the class decision
// beside the state model so a caller cannot accidentally turn the settled `gone` state
// back into an endless loading promise.
export function faceSkeletonClass(state: FaceState): '' | ' skeleton' {
  return faceSettled(state) ? '' : ' skeleton';
}

// What each answer of `GET /profile` means HERE — named so the decision can be read, and
// tested, on its own. GONE is the ONE answer with no face in it (`null`). `blank` (never
// customized) and `failed` (a transport error or a 5xx, which is not evidence of a
// deletion) both keep the assigned identity, which is genuinely this player's own.
export function faceFromRead(read: ProfileRead, publicId: string): Face | null {
  if (read.status === 'gone') return null;
  if (read.status === 'shown') {
    return {
      publicId,
      name: read.profile.name || anonName(publicId),
      avatar: read.profile.avatar,
    };
  }
  return { publicId, name: anonName(publicId), avatar: null };
}

// The account's face, `'gone'`, or null while the read is still out. `local` is the
// TOKENLESS case: the id is a placeholder seed no account exists for, so there is nothing
// to ask about and the assigned identity IS the answer — settled immediately, never a
// breathing promise, and never gone.
export function useAccountFace(publicId: string | null, local = false): FaceState {
  const [read, setRead] = useState<Settled | null>(null);

  useEffect(() => {
    if (publicId === null) {
      setRead(null);
      return;
    }
    if (local) {
      setRead({ publicId, face: { publicId, name: anonName(publicId), avatar: null } });
      return;
    }
    let mounted = true;
    (async () => {
      const answer = await readProfile(publicId, timeoutSignal(FACE_TIMEOUT_MS));
      if (mounted) setRead({ publicId, face: faceFromRead(answer, publicId) });
    })();
    return () => {
      mounted = false;
    };
  }, [publicId, local]);

  // Never a face belonging to a PREVIOUS account: a caller that is not remounted would
  // otherwise render the wrong person for as long as the new read takes.
  if (read?.publicId !== publicId) return null;
  return read.face ?? 'gone';
}

// THE FACE THIS DEVICE WEARS, whether or not it has an account yet — and the reason the
// account screens cannot tell you which (user-decided 2026-08-26). A deployed device reads
// its account's public profile; a tokenless one derives the SAME pair from the persisted
// local seed (`gameStore.localSeed`), which is exactly what `localIdentityDeploy` stores as
// the account's first profile the moment one is created. So the face before deployment and
// the face after it are the same face, and no screen has to branch on a status the player
// should never be shown.
export function useOwnFace(): FaceState {
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
