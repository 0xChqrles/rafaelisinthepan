// WHO an account is, on screen: its mark and its name (#204's UX rework).
//
// Two reads answer it. `useOwnFace` is the player's OWN face — the header's key, `/account`'s
// masthead, the email flow's lead, its crossroads' leaving side and its ending ("we found
// your account" is a claim only a FACE can make), the race line, the result's own line.
// `useAccountFace` is ANOTHER account's — the crossroads' joining side. The read is the
// invite landing's: a public GET, a short timeout, and the ASSIGNED identity when the
// profile never existed (or, for another account, when the read failed).
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
//
// **THE PLAYER'S OWN FACE HAS A FOURTH: `'failed'`** (user-delegated 2026-10-06). Another
// account whose read failed is dressed with its ASSIGNED identity, as a board row is — a
// stand-in nobody mistakes for themselves. The player's OWN face cannot be: a player who
// drew their mark and named themselves would be shown a stranger's pseudonym and mark as
// their own (`GoldenComet68` over Rafa_cuisine's page). So `useOwnFace` settles a failed
// first read as `'failed'` — what it is, the still stipple a failed read rests on — and the
// read is asked again (`retryOwnFace`: the masthead's tap, the tab coming back), the box
// breathing while it is out.
//
// **AND IT IS READ ONCE, FOR EVERY SURFACE THAT DRAWS IT** (`useOwnRead`, module state):
// asked once per account and revision by whichever surface asks first, and every caller of
// `useOwnFace` draws that one answer — so no surface rests on a failure while another draws
// the face, and a read asked again from any of them lands on all.

import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { anonName } from '@whippin/shared';
import { readProfile, type ProfileRead } from '../api';
import { useDeviceIdentity, useMintedHere } from '../identity';
import { useGameStore } from '../state/gameStore';
import { useOwnFaceSignal } from '../state/ownFace';
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

export type FaceState = Face | 'gone' | 'failed' | null;

// A settled read, TAGGED with the account it is about.
interface Settled {
  publicId: string;
  face: Exclude<FaceState, null>;
}

// The face to DRAW, or null when there is none — the read is still out, it failed (the own
// face), or the account is gone. `faceSettled` is what tells the first apart.
export function shownFace(state: FaceState): Face | null {
  return state === null || state === 'gone' || state === 'failed' ? null : state;
}

// Has the read ANSWERED? A deleted account answers with nothing to draw, and a caller that
// keeps a skeleton breathing over it is promising an arrival that is not coming; a failed
// read rests too, until it is asked again.
export function faceSettled(state: FaceState): boolean {
  return state !== null;
}

// A face slot breathes only while its read is genuinely pending. Keep the class decision
// beside the state model so a caller cannot accidentally turn the settled `gone` state
// back into an endless loading promise.
export function faceSkeletonClass(state: FaceState): '' | ' skeleton' {
  return faceSettled(state) ? '' : ' skeleton';
}

// The pseudonym and mark an id derives (`@whippin/shared` assigned.ts), as a face.
function assignedFace(publicId: string): Face {
  return { publicId, name: anonName(publicId), avatar: null };
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
  return assignedFace(publicId);
}

// What an answer SETTLES, given what was settled before it — the one spelling both reads
// (`useAccountFace`'s and the own face's) apply. A FAILED answer is no news: it never
// replaces a face already settled for this account, and where none is settled yet the
// caller's `standIn` settles — a face, or `'failed'` — else the assigned one.
function settle(
  prev: Settled | null,
  publicId: string,
  answer: ProfileRead,
  standIn: Face | 'failed' | null,
): Settled {
  if (answer.status !== 'failed') return { publicId, face: faceFromRead(answer, publicId) ?? 'gone' };
  return prev?.publicId === publicId ? prev : { publicId, face: standIn ?? assignedFace(publicId) };
}

// ANOTHER account's face, `'gone'`, or null while the read is still out; a failed read
// dresses it with its assigned identity.
export function useAccountFace(publicId: string | null): FaceState {
  const [read, setRead] = useState<Settled | null>(null);

  useEffect(() => {
    if (publicId === null) {
      setRead(null);
      return;
    }
    let mounted = true;
    (async () => {
      const answer = await readProfile(publicId, timeoutSignal(FACE_TIMEOUT_MS));
      if (!mounted) return;
      setRead((prev) => settle(prev, publicId, answer, null));
    })();
    return () => {
      mounted = false;
    };
  }, [publicId]);

  // Never a face belonging to a PREVIOUS account: a caller that is not remounted would
  // otherwise render the wrong person for as long as the new read takes.
  if (read?.publicId !== publicId) return null;
  return read.face;
}

// THE OWN FACE'S ONE READ, shared by every surface that draws it. `asked` names the read
// last asked (account, tokenless or not, revision, stand-in): a caller asking for the same
// one is already answered, so N surfaces mounted together cost ONE request, and a surface
// mounted later draws the face already settled instead of asking again. A newer ask
// supersedes an older one still out (`flight`): its answer is about a read nobody wants.
const useOwnRead = create<{ read: Settled | null }>(() => ({ read: null }));
let asked: string | undefined;
let flight = 0;

// `local` is the TOKENLESS case: the id is a placeholder seed no account exists for, so
// there is nothing to ask about and the assigned identity IS the answer — settled at once,
// never a breathing promise, and never gone. A new `revision` reads the same account AGAIN
// (its profile was just written, or a failed read is asked again): the face already settled
// stands until the answer lands — but a `'failed'` one goes back to waiting, so the box
// breathes while the read is out.
function askOwnFace(
  publicId: string | null,
  local: boolean,
  revision: number,
  standIn: Face | 'failed',
): void {
  const key = JSON.stringify([publicId, local, revision, standIn === 'failed' ? standIn : standIn.publicId]);
  if (key === asked) return;
  asked = key;
  const mine = (flight += 1);
  const set = (next: (prev: Settled | null) => Settled | null) =>
    useOwnRead.setState((s) => ({ read: next(s.read) }));
  if (publicId === null) {
    set(() => null);
    return;
  }
  if (local) {
    set(() => ({ publicId, face: assignedFace(publicId) }));
    return;
  }
  set((prev) => (prev?.publicId === publicId && prev.face === 'failed' ? null : prev));
  void readProfile(publicId, timeoutSignal(FACE_TIMEOUT_MS)).then((answer) => {
    if (mine === flight) set((prev) => settle(prev, publicId, answer, standIn));
  });
}

// THE FACE THIS DEVICE WEARS, whether or not it has an account yet — and the reason the
// account screens cannot tell you which (user-decided 2026-08-26). A deployed device reads
// its account's public profile; a tokenless one derives the SAME pair from the persisted
// local seed (`gameStore.localSeed`), which is exactly what `localIdentityDeploy` stores as
// the account's first profile the moment one is created. So the face before deployment and
// the face after it are the same face, and no screen has to branch on a status the player
// should never be shown.
//
// It follows the profile this device WRITES (`state/ownFace.ts`): a write re-reads it. And an
// account this tab MINTED (`mintedHere`) is brand new, its first profile being written as
// the seed's face: until that write has landed and been read back, the seed's face is still
// the one drawn — a read during the write would find no profile and draw the face derived
// from the new account id instead, a third face. What the read then answers wins: another
// writer's row (a 409), the id's face (the write never landed), or nothing (gone). A read
// that FAILED answers nothing, so the face already drawn stands: the seed's, on a minted
// account — and where no face was drawn yet, `'failed'`, never the id's assigned stranger.
export function useOwnFace(): FaceState {
  const identity = useDeviceIdentity();
  const mintedHere = useMintedHere();
  const firstWrite = useOwnFaceSignal((s) => s.firstWrites > 0);
  const revision = useOwnFaceSignal((s) => s.revision);
  const localSeed = useGameStore((s) => s.localSeed);
  const ensureLocalSeed = useGameStore((s) => s.ensureLocalSeed);
  const read = useOwnRead((s) => s.read);

  // The placeholder the leaderboard strip already shows, minted on first need so the two
  // surfaces can never show one visitor two faces.
  useEffect(() => {
    if (identity === null && localSeed === null) ensureLocalSeed();
  }, [identity, localSeed, ensureLocalSeed]);

  const seedFace = useMemo(() => (localSeed === null ? null : assignedFace(localSeed)), [localSeed]);
  const seeded = identity !== null && mintedHere && seedFace !== null;
  const publicId = seeded && firstWrite ? null : (identity?.accountId ?? localSeed);
  const local = identity === null;
  const standIn = seeded ? seedFace : 'failed';
  useEffect(() => {
    askOwnFace(publicId, local, revision, standIn);
  }, [publicId, local, revision, standIn]);

  // Never a face belonging to a PREVIOUS account (see `useAccountFace`).
  const state = read !== null && read.publicId === publicId ? read.face : null;
  return seeded && state === null ? seedFace : state;
}
