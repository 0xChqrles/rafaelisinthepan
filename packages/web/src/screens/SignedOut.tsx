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
// correct itself, the leaderboard strip's rule). The copy still says what is being left
// behind, and now also what START FRESH actually mints.
//
// RECONNECT — signing back into the account by email — is #204's flow, and it does not
// exist yet. The prop is how it arrives: one wire, no stub button in the meantime. A button
// that does nothing is worse than a screen that only offers what it can actually do.

import { useEffect, useState } from 'react';
import { anonName, defaultAvatar } from '@whippin/shared';
import { parseProfile, profileUrl } from '../api';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import LoadingWave from '../components/LoadingWave';
import { startFreshDevice, useSignedOutAccount } from '../identity';
import { t } from '../i18n';

interface Face {
  name: string;
  avatar: string | null;
}

export default function SignedOut({
  lang,
  onReconnect,
}: {
  lang: string;
  // #204's email link flow, when it lands. Absent today, so only SKIP is offered.
  onReconnect?: () => void;
}) {
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
      let shown: Face = { name: anonName(publicId), avatar: null };
      try {
        const response = await fetch(profileUrl(publicId), {
          signal: AbortSignal.timeout(6_000),
        });
        if (response.ok) {
          const profile = parseProfile(await response.json());
          shown = { name: profile.name || anonName(publicId), avatar: profile.avatar };
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

  // The face read is in flight: hold the frame rather than flashing a name that may be
  // about to change. A verdict that carried no identity (theoretical) skips straight to
  // the faceless copy below.
  if (account !== null && face === null) {
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
      {onReconnect && (
        <Button variant="primary" onClick={onReconnect}>
          {t(lang, 'signedOutReconnect')}
        </Button>
      )}
      <Button variant="secondary" onClick={startFreshDevice}>
        {t(lang, 'signedOutSkip')}
      </Button>
    </div>
  );
}
