// The share's INVITE toggle (user-decided 2026-09-05): beside SHARE on both result screens,
// ON by default, and NEVER persisted — every result screen mounts it fresh, so a player who
// turned it off for one share is asked again by the next. On, the share link is SIGNED
// (`/s/<token>/<publicId>`, `shared/invite.ts`): the card carries the player's mark and
// name, and the click lands on the invite landing with the result, where ADD FRIEND
// records the mutual edge. Off, the link is today's plain share, byte for byte.
//
// THE WORDING IS POSITIVE AND THE FACE IS THE EXPLANATION. Not "don't share my profile"
// (an unchecked negative reads as a warning, and a double negative is what people get
// wrong), but the thing the reader gets — an INVITE — with the player's OWN mark inside the
// chip, which says "this goes with the link" without a sentence. A tokenless device holds
// no account to invite anyone to, so it has no chip at all: the result screens only ever
// show it after PLAY deployed the account.

import { useState } from 'react';
import { defaultAvatar } from '@whippin/shared';
import Avatar from './Avatar';
import { shownFace, useOwnFace } from './AccountFace';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';

export interface ShareSigner {
  // The publicId the link is signed with when the toggle is on; null when it is off or
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

export default function ShareInvite({ lang, signer }: { lang: string; signer: ShareSigner }) {
  const face = shownFace(useOwnFace());
  if (signer.signer === null) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={signer.on}
      aria-label={t(lang, 'shareInviteHint')}
      className={`share-invite${signer.on ? ' on' : ''}`}
      onClick={signer.toggle}
    >
      <i className="share-invite-box" aria-hidden="true" />
      <span className="share-invite-face">
        {face && <Avatar avatar={face.avatar ?? defaultAvatar(signer.signer)} size={22} sharp />}
      </span>
      <span className="share-invite-label">{t(lang, 'shareInvite')}</span>
    </button>
  );
}
