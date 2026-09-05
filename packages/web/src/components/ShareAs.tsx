// WHO a share is FROM (user-decided 2026-09-05, five passes the same day): under SHARE on
// both result screens, the label AS and a small DRUM holding two rows — the player's own
// mark and name, or ANONYMOUS — turned like every wheel in the app (`useDrum`, the hole
// wheel's and the header selection's physics). The row in the slot is the pick; it opens on
// the player, so a share left alone is signed. NEVER persisted: every result screen mounts
// it fresh, so a player who turned it to ANONYMOUS for one share is asked again by the next.
//
// ONE ROW TALL. The first drum showed three rows and stood 90px high, which put the label
// "too far from the share button — we don't get the link between them anymore" (user
// feedback, fifth pass). So the drum is the SLOT alone, with a sliver of the other row
// showing through the fade above or below it — enough to read as a wheel, no taller than a
// line — and a CHEVRON beside it that flips the two rows for anyone who would rather tap
// than turn; a tap on the slot row flips it too, since with two rows "the other one" is
// unambiguous. It sits directly under SHARE in the actions' own gap.
//
// Signed, the share link carries the player's publicId as a second segment
// (`/s/<token>/<publicId>`, `shared/invite.ts`): the card wears the mark and name, and the
// click lands on the invite landing with the result, where ADD FRIEND records the mutual
// edge. Anonymous, the link is today's plain share, byte for byte.
//
// WHY A DRUM, AND WHY THESE WORDS. A chip reading INVITE looked like a button and "invite"
// was weird; a checkbox reading SHARE MY PROFILE was scary (it named what the player gives,
// not what the reader gets); a checkbox reading `AS <mark> <name>` put a square beside a
// square — the box read as a second face. So the choice is shown as a CHOICE between two
// named options, in the app's own picker grammar, with the room the retired rank line
// left. "Anonymous" names the other row honestly now that it is an option rather than the
// label of an unticked box. A tokenless device holds no account to sign with, so it has
// no drum at all: the result screens only ever show it after PLAY deployed the account,
// and the drum waits for the face to settle rather than flashing a name in.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { defaultAvatar } from '@whippin/shared';
import ChevronDownIcon from '../assets/icons/chevron-down.svg?react';
import Avatar from './Avatar';
import { shownFace, useOwnFace } from './AccountFace';
import useDrum from '../hooks/useDrum';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';

export interface ShareSigner {
  // The publicId the link is signed with while the player's row is in the slot; null
  // while ANONYMOUS is, or when the device holds no account.
  by: string | null;
  signer: string | null;
  on: boolean;
  setOn: (on: boolean) => void;
}

export function useShareSigner(): ShareSigner {
  const identity = useDeviceIdentity();
  const [on, setOn] = useState(true);
  const signer = identity?.accountId ?? null;
  return { by: on ? signer : null, signer, on, setOn };
}

// The slot alone shows, with PEEK px of the neighbouring row fading in above or below.
const ROW_H = 26;
const GAP = 6;
const PITCH = ROW_H + GAP;
const PEEK = 7;
const BOX_H = ROW_H + 2 * PEEK;

export default function ShareAs({ lang, signer }: { lang: string; signer: ShareSigner }) {
  const face = shownFace(useOwnFace());
  const box = useRef<HTMLDivElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const drum = useDrum({
    ref: box,
    active: face !== null,
    count: 2,
    pitch: PITCH,
    initial: signer.on ? 0 : 1,
    write: (px) => {
      if (track.current) track.current.style.translate = `0 ${-px}px`;
    },
  });
  // Open on the held row, before paint.
  const opened = useRef(false);
  useEffect(() => {
    if (face === null || opened.current) return;
    opened.current = true;
    drum.jump(signer.on ? 0 : 1);
  }, [drum, face, signer.on]);
  // The row in the slot IS the pick — reported as the drum turns, so a share tapped
  // mid-glide still goes out as whatever the slot holds.
  const { setOn } = signer;
  useEffect(() => {
    setOn(drum.current === 0);
  }, [drum.current, setOn]);

  if (signer.signer === null || face === null) return null;

  const rows = [
    {
      key: 'me',
      label: face.name,
      chip: (
        <>
          <span className="share-as-face" aria-hidden="true">
            <Avatar avatar={face.avatar ?? defaultAvatar(signer.signer)} size={16} sharp />
          </span>
          <span className="share-as-name">{face.name}</span>
        </>
      ),
    },
    { key: 'anon', label: t(lang, 'shareAnon'), chip: t(lang, 'shareAnon') },
  ];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      drum.glideBy(e.key === 'ArrowDown' ? 1 : -1);
    }
  };
  // The other row — the only place a two-row drum can go.
  const flip = () => drum.glideBy(drum.current === 0 ? 1 : -1);

  return (
    <div className="share-as">
      <span className="share-as-label" id="share-as-label">
        {t(lang, 'shareAs')}
      </span>
      <div
        className="share-as-drum"
        ref={box}
        role="radiogroup"
        aria-labelledby="share-as-label"
        style={{ height: BOX_H }}
        onKeyDown={onKeyDown}
      >
        <div className="share-as-track" ref={track}>
          <div style={{ height: PEEK }} />
          {rows.map((row, i) => {
            const inSlot = i === drum.current;
            return (
              <button
                key={row.key}
                type="button"
                role="radio"
                aria-checked={inSlot}
                aria-label={row.label}
                className={`share-as-row${inSlot ? ' on' : ''}`}
                style={{ height: ROW_H, marginBottom: GAP } as CSSProperties}
                onClick={() => {
                  if (drum.tap(i) === 'slot') flip();
                }}
              >
                <span className="share-as-chip">{row.chip}</span>
              </button>
            );
          })}
          <div style={{ height: PEEK }} />
        </div>
      </div>
      <button
        type="button"
        className={`share-as-flip${drum.current === 1 ? ' up' : ''}`}
        aria-label={rows[drum.current === 0 ? 1 : 0].label}
        onClick={flip}
      >
        <ChevronDownIcon className="ui-icon" aria-hidden />
      </button>
    </div>
  );
}
