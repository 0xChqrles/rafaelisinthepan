// The username is decided LOCALLY and DEPLOYED with the account (user-decided
// 2026-08-26, superseding the display-only half of the #188 assigned-identity rule).
//
// Until this module existed, a tokenless device showed a placeholder identity derived
// from the persisted local seed (`gameStore.localSeed` — `anonName`/`defaultAvatar`),
// and the moment a deploy button minted the account the strip swapped to an identity
// derived from the SERVER-assigned publicId instead — the server picks that id, so no
// local value could match it, and every new player watched their own name change once.
//
// The fix keeps the decision where it was made: when THIS device acquires an identity,
// the placeholder it has been showing is stored as the account's real profile unless
// something is already stored (even an empty row is somebody's deliberate avatar-only
// save). The read's 404 avoids an unnecessary write; the POST's atomic create is the
// authority if another writer lands between them. From then on every surface reads the
// same stored values: your own strip, your friends' boards, the invite card.
//
// It listens to the identity lifecycle here — the same one readable block identityScope
// owns — rather than at each of the five deploy triggers, so a future trigger cannot
// forget it. The ONE trigger that must not be overridden is the profile editor's SAVE:
// there the player typed their own name in the same gesture, so its deploy runs inside
// `withoutLocalIdentityDeploy`, which mutes this listener for exactly that acquisition.

import { anonName, defaultAvatar } from '@whippin/shared';
import {
  identityEpoch,
  identityEpochOf,
  onIdentityChange,
  type DeviceIdentity,
} from '../identity';
import { postProfileBody, profileUrl } from '../api';
import { useGameStore } from './gameStore';
import { adoptSignedOutVerdict } from './signedOutVerdict';
import { timeoutSignal } from '../timeout';

// A failed deployment is retried BOUNDED and then abandoned, never surfaced: like the
// streak credit, it is a side effect of an answer the player already saw. If it never
// lands, every surface falls back to deriving the face from the account id — today's
// behavior — and the editor can still set a name by hand.
const DEPLOY_RETRIES = 2;
const DEPLOY_RETRY_MS = 1_000;
// Both calls are BOUNDED, the signed-out screen's own figure for its public profile read.
// Nothing here is on screen, so a hung request surfaces nowhere — it just parks this
// account's entry in `inFlight` for the page's life, and the acquisition that would retry
// the deployment gets handed the promise that never settles instead.
const DEPLOY_TIMEOUT_MS = 6_000;

let uninstall: (() => void) | null = null;

// Set while the profile editor's SAVE deploys the account: whatever identity arrives
// during this window belongs to a save carrying the player's OWN fields, which must win.
let suppressed = false;

export async function withoutLocalIdentityDeploy<T>(work: () => Promise<T>): Promise<T> {
  suppressed = true;
  try {
    return await work();
  } finally {
    suppressed = false;
  }
}

// One deployment in flight per ACCOUNT (the activeScoreFlights pattern): the listener can
// fire twice for one acquisition — publish and a fast storage echo — and StrictMode
// remounts re-register it; the second look must not double-write behind the first.
const inFlight = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deploy(identity: DeviceIdentity): Promise<void> {
  const held = inFlight.get(identity.accountId);
  if (held) return held;
  const task = run(identity).finally(() => inFlight.delete(identity.accountId));
  inFlight.set(identity.accountId, task);
  return task;
}

async function run(identity: DeviceIdentity): Promise<void> {
  const epoch = identityEpochOf(identity);
  const stale = () => identityEpoch() !== epoch;
  // The seed may still be null on a first act that never opened a board or editor (Word
  // mode's PLAY): deciding it HERE keeps the rule honest — the username exists locally
  // from the first moment anything needed it, and this is the same value such a visit
  // would have been shown.
  const seed = useGameStore.getState().ensureLocalSeed();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const read = await fetch(profileUrl(identity.accountId), {
        signal: timeoutSignal(DEPLOY_TIMEOUT_MS),
      });
      if (stale()) return;
      if (read.ok) return; // Something is stored — even '' /null is a deliberate save.
      if (read.status !== 404) throw new Error(`profile read: ${read.status}`);
      // Never customized: store what this device has been showing all along.
      const response = await postProfileBody(profileUrl(), {
        token: identity.token,
        name: anonName(seed),
        avatar: defaultAvatar(seed),
        // The GET above avoids an unnecessary write, but it cannot provide the invariant:
        // the editor or another device may create the row before this POST lands. The
        // backend's conditional write is the authority that makes this background task
        // incapable of replacing a deliberate profile.
        createOnly: true,
      }, timeoutSignal(DEPLOY_TIMEOUT_MS));
      if (stale()) return;
      if (response.ok) return;
      // ONE read of the body, then everything classifies off the parsed value (review
      // finding). This is the only caller that needs the refusal AFTER asking for the
      // verdict, and asking first consumed the body: `adoptSignedOutVerdict` calls `.json()`
      // itself, so the second call threw and every refusal below silently read as null. Dead
      // today — `unknown_device` is the only 401 this route answers, so the verdict always
      // returned true before reaching them — and a trap the moment it is not. Feeding the
      // helper the value keeps it the ONE spelling of that resolution, which a `clone()`
      // would too, except the mocked responses these paths are tested against have none.
      const refusal = (await response.json().catch(() => null)) as { error?: string } | null;
      // Do not retry a token the server has already rejected and leave the rest of the app
      // falsely believing it is signed in.
      if (await adoptSignedOutVerdict({ status: response.status, json: async () => refusal }, epoch))
        return;
      // A deliberate profile won the create race. That is the desired end state: leave it
      // untouched and finish without retrying the same impossible conditional write.
      if (response.status === 409 && refusal?.error === 'profile_exists') return;
      // Moderation refused the generated values: retrying cannot help (the editor's rule).
      if (
        response.status === 400 &&
        (refusal?.error === 'name_rejected' || refusal?.error === 'avatar_rejected')
      ) {
        console.warn('[identity] the assigned identity was refused — leaving the fallback', refusal?.error);
        return;
      }
      throw new Error(`profile deploy: ${response.status}`);
    } catch (error) {
      if (stale()) return;
      if (attempt >= DEPLOY_RETRIES) {
        console.warn('[identity] deploying the local identity failed — leaving the fallback', error);
        return;
      }
      await sleep(DEPLOY_RETRY_MS * 2 ** attempt);
      if (stale()) return;
    }
  }
}

export function installLocalIdentityDeploy(): () => void {
  uninstall?.();
  const remove = onIdentityChange(({ next }) => {
    // Leaving an identity deploys nothing, and an acquisition inside the editor's SAVE
    // window belongs to the save's own body — the placeholder must not race it.
    if (next === null || suppressed) return;
    void deploy(next);
  });
  uninstall = remove;
  return () => {
    remove();
    if (uninstall === remove) uninstall = null;
  };
}
