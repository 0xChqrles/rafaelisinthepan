// The share's PROFILE checkbox (user-decided 2026-09-05, reworded and reshaped the same
// day: "the check option looks like a button, and not like a checkbox", "the term invite is
// weird"): under SHARE on both result screens, a plain CHECKBOX reading SHARE MY PROFILE,
// checked by default, and NEVER persisted — every result screen mounts it fresh, so a
// player who unchecked it for one share is asked again by the next. Checked, the share
// link is SIGNED (`/s/<token>/<publicId>`, `shared/invite.ts`): the card carries the
// player's mark and name, and the click lands on the invite landing with the result, where
// ADD FRIEND records the mutual edge. Unchecked, the link is today's plain share, byte for
// byte.
//
// The wording is the user's own and POSITIVE: not a "don't share my profile" opt-out (an
// unchecked negative reads as a warning, and a double negative is what people get wrong),
// but what the reader gets, ticked. A real `<input type="checkbox">` inside a label — the
// one control every reader already knows how to read — with the app's own square drawn
// over it. A tokenless device holds no account to sign with, so it has no checkbox at all:
// the result screens only ever show it after PLAY deployed the account.

import { useState } from 'react';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';

export interface ShareSigner {
  // The publicId the link is signed with when the box is checked; null when it is not or
  // the device holds no account.
  by: string | null;
  signer: string | null;
  on: boolean;
  toggle: () => void;
}

export function useShareSigner(): ShareSigner {
  const identity = useDeviceIdentity();
  const [on, setOn] = useState(true);
  const signer = identity?.accountId ?? null;
  return {
    by: on ? signer : null,
    signer,
    on,
    toggle: () => setOn((v) => !v),
  };
}

export default function ShareProfile({ lang, signer }: { lang: string; signer: ShareSigner }) {
  if (signer.signer === null) return null;
  return (
    <label className="share-profile">
      <input type="checkbox" checked={signer.on} onChange={signer.toggle} />
      <span className="share-profile-box" aria-hidden="true" />
      <span className="share-profile-label">{t(lang, 'shareProfile')}</span>
    </label>
  );
}
