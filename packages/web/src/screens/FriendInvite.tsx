import { useEffect, useState } from 'react';
import LoadingWave from '../components/LoadingWave';
import LoadError from '../components/LoadError';
import { friendsUrl, postFriendsBody } from '../api';
import { playerSecret } from '../identity';
import { t } from '../i18n';
import { navigate } from '../routing';

// The #189 invite link's landing: `/i/<publicId>` records the MUTUAL edge and gets out of
// the way. One link does both jobs — "add me" and "come play" — so this is a beat, not a
// destination: the write goes out with the CLICKER's own key (generated on this first need
// if they have never played, which is what lands the edge before their first game), and the
// app continues home the moment the server has answered.
//
// The landing replaces itself in history, so a back tap leaves the game rather than
// re-firing the invite, and it hands the destination to App's own home redirect rather than
// restating where a player lands.
//
// A 4xx is a VERDICT, not a failure — the score submission's rule. Opening your own link
// (`self_link`), or one naming an id nobody holds, cannot be fixed by asking again, so those
// continue into the game. Only a transport error or a 5xx is worth retrying, and THAT is
// loud rather than silent (the #188 profile read's rule): the write is the one thing this
// click existed to do, so losing it quietly would leave both players none the wiser.
//
// The cap (409 `friend_limit`) is a verdict too — asking again will not empty a full list —
// but it is the ONE the player could act on, and the same "losing it quietly" argument
// applies to it: a player at FRIENDS_MAX would otherwise click invitations forever and watch
// each one appear to work. So it neither retries nor vanishes: it says so, and its button
// plays. Neutral about whose list is full, because the cap binds either side of the pair and
// the answer does not say which.
export type InviteOutcome = 'settled' | 'full' | 'failed';

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
  const response = await postFriendsBody(friendsUrl(), {
    secret: playerSecret(),
    add: publicId,
  });
  if (response.status >= 500) return 'failed';
  return response.status === 409 ? 'full' : 'settled';
}

// Hand the destination to App's own home redirect, and replace this landing in history so a
// back tap leaves the game instead of re-firing the invite.
const continueToGame = () => navigate('/', { replace: true });

export default function FriendInvite({ publicId, lang }: { publicId: string; lang: string }) {
  const [attempt, setAttempt] = useState(0);
  const [stopped, setStopped] = useState<'full' | 'failed' | null>(null);

  useEffect(() => {
    let mounted = true;
    void shareInviteFlight(publicId, () => sendInvite(publicId)).then((outcome) => {
      if (!mounted) return;
      if (outcome === 'settled') continueToGame();
      else setStopped(outcome);
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
  return (
    <p className="status">
      <LoadingWave text={t(lang, 'loading')} />
    </p>
  );
}
