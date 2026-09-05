// The share's PROFILE checkbox (user-decided 2026-09-05, in three passes the same day): under
// SHARE on both result screens, a plain CHECKBOX, checked by default, NEVER persisted —
// every result screen mounts it fresh, so a player who unchecked it for one share is asked
// again by the next. Checked, the share link is SIGNED (`/s/<token>/<publicId>`,
// `shared/invite.ts`): the card carries the player's mark and name, and the click lands on
// the invite landing with the result, where ADD FRIEND records the mutual edge. Unchecked,
// the link is today's plain share, byte for byte.
//
// THE LABEL IS WHAT THE READER WILL SEE: `AS <mark> <name>`. The first cut was a glass chip
// reading INVITE ("looks like a button", "the term invite is weird"); the second a checkbox
// reading SHARE MY PROFILE, which "can be scary" — it names what the player GIVES rather
// than what the reader GETS, and a scary label is an unticked one. "Anonymously" was tried
// on paper and "doesn't click": it names the absence. So the label shows the signature
// itself, and unticking it dims the face — the reader sees the result, and this is who it
// is from. The user's own suggestion. A tokenless device holds no account to sign with, so
// it has no checkbox at all: the result screens only ever show it after PLAY deployed the
// account, and the box waits for the face to settle rather than flashing a name in.

import { useState } from 'react';
import { defaultAvatar } from '@whippin/shared';
import Avatar from './Avatar';
import { shownFace, useOwnFace } from './AccountFace';
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
  const face = shownFace(useOwnFace());
  if (signer.signer === null || face === null) return null;
  return (
    <label className="share-profile">
      <input
        type="checkbox"
        checked={signer.on}
        onChange={signer.toggle}
        aria-label={`${t(lang, 'share')} ${t(lang, 'shareAs')} ${face.name}`}
      />
      <span className="share-profile-box" aria-hidden="true" />
      <span className="share-profile-label" aria-hidden="true">
        {t(lang, 'shareAs')}
      </span>
      <span className="share-profile-face" aria-hidden="true">
        <Avatar avatar={face.avatar ?? defaultAvatar(signer.signer)} size={18} sharp />
      </span>
      <span className="share-profile-name" aria-hidden="true">
        {face.name}
      </span>
    </label>
  );
}
