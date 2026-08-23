import { useEffect, useState } from 'react';
import { anonName, defaultAvatar } from '@whippin/shared';
import Avatar from '../components/Avatar';
import LoadingWave from '../components/LoadingWave';
import LoadError from '../components/LoadError';
import { friendsUrl, parseProfile, postFriendsBody, profileUrl } from '../api';
import { ensureDeviceIdentity, markDeviceSignedOut } from '../identity';
import { t } from '../i18n';
import { navigate } from '../routing';

// The #189 invite link's landing: `/join/<publicId>` records the MUTUAL edge, SAYS SO,
// and then gets out of the way. One link does both jobs — "add me" and "come play" — so
// the write goes out with the CLICKER's own key (generated on this first need if they
// have never played, which is what lands the edge before their first game).
//
// The link a player SHARES is still `/i/<publicId>`; since 2026-08-20 the backend serves
// that path so the link unfurls in a chat as the sender's own mark and name, then bounces
// here (`shared/invite.ts` holds both paths). Nothing about this screen's job moved with
// it — the preview cannot touch the graph, because the edge needs the clicker's key and
// the clicker's device is the only place it exists.
//
// A SUCCESSFUL add is confirmed on screen (user feedback 2026-08-20 — the landing used
// to continue into the game without a word, leaving the clicker unsure anything had
// happened): the INVITER's mark and name over FRIEND ADDED, with PLAY carrying on. The
// profile read that dresses it is best-effort — a 404 or a failed read falls back to
// the pseudonym and the blank mark, never to an error: the edge is already landed, and
// that is the one thing this click existed to do.
//
// The landing replaces itself in history, so a back tap leaves the game rather than
// re-firing the invite, and PLAY hands the destination to App's own home redirect
// rather than restating where a player lands.
//
// A non-cap 4xx is a VERDICT, not a failure — the score submission's rule. Opening your
// own link (`self_link`), or one naming an id nobody holds, cannot be fixed by asking
// again, so those continue into the game silently (nothing was added, and there is no
// friend to announce). Only a transport error or a 5xx is worth retrying, and THAT is
// loud rather than silent (the #188 profile read's rule): losing the write quietly
// would leave both players none the wiser.
//
// The cap (409 `friend_limit`) is a verdict too — asking again will not empty a full
// list — but it is the ONE the player could act on, and the same "losing it quietly"
// argument applies: a player at FRIENDS_MAX would otherwise click invitations forever
// and watch each one appear to work. So it neither retries nor vanishes: it says so,
// and its button plays. Neutral about whose list is full, because the cap binds either
// side of the pair and the answer does not say which.
export type InviteOutcome = 'added' | 'settled' | 'full' | 'failed';

// One conversation per invite, shared across COMPONENT lifetimes — the score submission's
// own map, for its own reason: a ref survives React's development effect replay but not a
// real remount, while the request it started keeps running. Settled work is dropped
// immediately so RETRY mints a fresh attempt.
const activeInviteFlights = new Map<string, Promise<InviteOutcome>>();

export function shareInviteFlight(
  publicId: string,
  start: () => Promise<InviteOutcome>,
): Promise<InviteOutcome> {
  const existing = activeInviteFlights.get(publicId);
  if (existing) return existing;

  const flight = (async () => {
    try {
      return await start();
    } catch {
      // Offline, blocked, missing config — all the same outcome: the edge did not land.
      return 'failed' as const;
    }
  })();
  activeInviteFlights.set(publicId, flight);
  void flight.then(() => {
    if (activeInviteFlights.get(publicId) === flight) activeInviteFlights.delete(publicId);
  });
  return flight;
}

export async function sendInvite(publicId: string): Promise<InviteOutcome> {
  // ACCEPTING AN INVITE IS A TRIGGER (#216) — and the one that cannot be gated, because the
  // accepter is by definition a brand-new visitor clicking a link. Their identity is minted
  // on this first need, which is what lands the edge before their first game.
  const identity = await ensureDeviceIdentity();
  const response = await postFriendsBody(friendsUrl(), {
    token: identity.token,
    add: publicId,
  });
  // A 2xx landed the edge (a re-click of an already-accepted link included — you ARE
  // friends, which is exactly what the confirmation says).
  if (response.ok) return 'added';
  if (response.status >= 500) return 'failed';
  // A device signed out from elsewhere: the screen that explains it takes over, and the
  // click continues into the game with nothing announced (no edge was added).
  if (response.status === 401) {
    const data = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (data.error === 'unknown_device') markDeviceSignedOut();
  }
  return response.status === 409 ? 'full' : 'settled';
}

// What the confirmation shows for the INVITER: their public profile when it answers,
// the pseudonym + blank mark otherwise.
interface Inviter {
  name: string;
  avatar: string | null;
}

// Hand the destination to App's own home redirect, and replace this landing in history so a
// back tap leaves the game instead of re-firing the invite.
const continueToGame = () => navigate('/', { replace: true });

export default function FriendInvite({ publicId, lang }: { publicId: string; lang: string }) {
  const [attempt, setAttempt] = useState(0);
  const [stopped, setStopped] = useState<'full' | 'failed' | null>(null);
  const [inviter, setInviter] = useState<Inviter | null>(null);

  useEffect(() => {
    let mounted = true;
    void shareInviteFlight(publicId, () => sendInvite(publicId)).then(async (outcome) => {
      if (!mounted) return;
      if (outcome === 'settled') {
        continueToGame();
        return;
      }
      if (outcome !== 'added') {
        setStopped(outcome);
        return;
      }
      // The edge is landed; dress the confirmation with who was added. Best-effort —
      // any miss (404 never customized, transport, bad shape) falls back to the
      // pseudonym + assigned mark, never to an error. Best-effort also means BOUNDED:
      // this landing renders no header and no controls until the confirmation mounts,
      // so a read that STALLS (a dead connection that never errors) would strand the
      // clicker on a bare LOADING with only a reload — which re-fires the POST — as
      // the way out. After a few seconds the fallback IS the answer.
      let added: Inviter = { name: anonName(publicId), avatar: null };
      try {
        const response = await fetch(profileUrl(publicId), {
          signal: AbortSignal.timeout(6_000),
        });
        if (response.ok) {
          const profile = parseProfile(await response.json());
          added = { name: profile.name || anonName(publicId), avatar: profile.avatar };
        }
      } catch {
        // Keep the fallback.
      }
      if (mounted) setInviter(added);
    });
    return () => {
      mounted = false;
    };
  }, [publicId, attempt]);

  // The cap is a state, so its button carries the player on; a backend failure is a hiccup,
  // so its button asks again. One surface either way — the click never dead-ends.
  if (stopped === 'full') {
    return (
      <LoadError
        message={t(lang, 'friendListFull')}
        lang={lang}
        onRetry={continueToGame}
        actionLabel={t(lang, 'gatePlay')}
      />
    );
  }
  if (stopped === 'failed') {
    return (
      <LoadError
        message={t(lang, 'failedInvite')}
        lang={lang}
        onRetry={() => {
          setStopped(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (inviter) {
    return (
      <div className="invite-done">
        <Avatar avatar={inviter.avatar ?? defaultAvatar(publicId)} size={64} />
        <span className="invite-done-name">{inviter.name}</span>
        <p className="invite-done-line" role="status">
          {t(lang, 'inviteAdded')}
        </p>
        <button type="button" className="mix-btn" onClick={continueToGame}>
          {t(lang, 'gatePlay')}
        </button>
      </div>
    );
  }
  return (
    <p className="status">
      <LoadingWave text={t(lang, 'loading')} />
    </p>
  );
}
