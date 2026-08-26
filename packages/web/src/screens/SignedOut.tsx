// This device has been signed out (#216).
//
// It renders on ONE signal and nothing else: the server answered `unknown_device`, meaning
// the device item this token names is gone — someone signed it out from another device. A
// 5xx, a dropped connection or any other refusal must never land here; those are hiccups
// with retries, and treating one as a sign-out would take a player's account away over a
// bad connection.
//
// **The screen shows WHO was signed out** (user feedback 2026-08-26: the sentence-only
// first cut read as an abstract error — "even me I was a bit lost"). It wears the invite
// landing's own shape — the ACCOUNT's mark and name over what happened — so the player
// recognizes the account they are being asked to leave before choosing. The face is the
// public profile read (the invite landing's exact pattern: held behind a LoadingWave
// until it settles, assigned identity as the fallback — a name must never flash and then
// correct itself, the leaderboard strip's rule).
//
// **THE ACTION IS `PLAY`, AND THE COPY IS ABOUT IT** (user-decided 2026-08-26, superseding
// START FRESH and its paragraph of stakes). The reader has one decision here, so the screen
// says the one thing they need before making it — this tap starts over on a new account,
// and the one named above is left — in two short sentences, in the shared `gatePlay` label
// both game gates already wear. The tap then has to BE that: it lifts the verdict and hands
// the destination to App's home redirect (`FriendInvite`'s own `continueToGame`), because a
// button that says PLAY on a leaderboard route must not leave the player on the leaderboard.
// The new account itself is minted by the game's own PLAY gate, the #216 trigger it lands on.
//
// **RECONNECT LANDED WITH #204, and it is the PRIMARY action now.** Signing back into the
// account by email is what this screen's reader most likely wants — the account named above
// is theirs, and it is reachable — so it leads, and PLAY (start over on a new one) becomes
// the secondary. The tap LIFTS the verdict (which is what removes the persisted tombstone,
// origin-wide — the fenced state's one gesture, and the reason a reconnect can mint at all)
// and lands on the profile editor, the identity screen, where the link flow lives. Leaving
// mid-flow costs exactly what SKIP already cost: this device is a fresh visitor, and the
// account it left stands, reachable by its own address the moment one is bound to it.

import { useEffect, useState } from 'react';
import { anonName, defaultAvatar } from '@whippin/shared';
import { parseProfile, profileUrl } from '../api';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import LoadingWave from '../components/LoadingWave';
import { startFreshDevice, useSignedOutAccount } from '../identity';
import { t } from '../i18n';
import { ACCOUNT_EMAIL_PATH } from '../langs';
import { navigate } from '../routing';

// Leave the account behind and go play: the verdict is lifted (which is also what removes
// the persisted tombstone, origin-wide), then App's home redirect resolves the last-played
// game route — `FriendInvite`'s exact hand-off.
const playFresh = () => {
  startFreshDevice();
  navigate('/', { replace: true });
};

// RECONNECT: leave the fenced state and go STRAIGHT to the email step (#204). Not the
// editor, not even the account screen — a player who has just been signed out has exactly
// one intention, and every screen between them and the address field is a screen they have
// to read past. It uses the SAME gesture PLAY does — the tombstone stands until the player
// chooses, and choosing to sign back in is a choice — so a reconnect abandoned halfway is
// simply a fresh visitor, never a device stuck on this screen.
const reconnect = () => {
  startFreshDevice();
  navigate(ACCOUNT_EMAIL_PATH);
};

// The face is TAGGED WITH THE ACCOUNT IT BELONGS TO (review finding). A tab sitting on
// this screen holds no identity, so a tombstone arriving from a sibling tab for a DIFFERENT
// account is adopted rather than ignored (identity.ts's storage sync) — and `account` then
// changes under a component that is not remounted. Without the tag the previously loaded
// name and mark keep rendering over the new account until the next read lands, which is up
// to the 6-second timeout on a bad connection: the wrong person's face on the one screen
// whose whole job is naming who you are about to leave.
interface Face {
  publicId: string;
  name: string;
  avatar: string | null;
}

export default function SignedOut({ lang }: { lang: string }) {
  const account = useSignedOutAccount();
  const [face, setFace] = useState<Face | null>(null);

  // The account's face — the invite landing's read: public GET, short timeout, and the
  // ASSIGNED identity when the profile never existed or the read failed. This is display
  // only and mints nothing (#216: a signed-out device makes no private call).
  useEffect(() => {
    if (account === null) return;
    let mounted = true;
    const publicId = account.accountId;
    (async () => {
      let shown: Face = { publicId, name: anonName(publicId), avatar: null };
      try {
        const response = await fetch(profileUrl(publicId), {
          signal: AbortSignal.timeout(6_000),
        });
        if (response.ok) {
          const profile = parseProfile(await response.json());
          shown = { publicId, name: profile.name || anonName(publicId), avatar: profile.avatar };
        }
      } catch {
        // Keep the fallback.
      }
      if (mounted) setFace(shown);
    })();
    return () => {
      mounted = false;
    };
  }, [account]);

  // The face read is in flight — or the one in hand belongs to a PREVIOUS account: hold the
  // frame rather than flashing a name that may be about to change, or one that was never
  // this account's. A verdict that carried no identity (theoretical) skips straight to the
  // faceless copy below.
  if (account !== null && face?.publicId !== account.accountId) {
    return (
      <p className="status">
        <LoadingWave text={t(lang, 'loading')} />
      </p>
    );
  }

  return (
    <div className="signed-out">
      {account !== null && face !== null && (
        <>
          <Avatar avatar={face.avatar ?? defaultAvatar(account.accountId)} size={64} />
          <span className="signed-out-name">{face.name}</span>
        </>
      )}
      <p className="signed-out-line" role="status">
        {t(lang, 'signedOut')}
      </p>
      <p className="no-puzzle-note">{t(lang, 'signedOutNote')}</p>
      <Button variant="primary" onClick={reconnect}>
        {t(lang, 'signedOutReconnect')}
      </Button>
      <Button variant="secondary" onClick={playFresh}>
        {t(lang, 'gatePlay')}
      </Button>
    </div>
  );
}
