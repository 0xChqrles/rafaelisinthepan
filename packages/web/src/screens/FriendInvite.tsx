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

// One conversation per invite, shared across COMPONENT lifetimes — the score submission's
// own map, for its own reason: a ref survives React's development effect replay but not a
// real remount, while the request it started keeps running. Settled work is dropped
// immediately so RETRY mints a fresh attempt.
const activeInviteFlights = new Map<string, Promise<'settled' | 'failed'>>();

export function shareInviteFlight(
  publicId: string,
  start: () => Promise<'settled' | 'failed'>,
): Promise<'settled' | 'failed'> {
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

export async function sendInvite(publicId: string): Promise<'settled' | 'failed'> {
  const response = await postFriendsBody(friendsUrl(), {
    secret: playerSecret(),
    add: publicId,
  });
  return response.status >= 500 ? 'failed' : 'settled';
}

export default function FriendInvite({ publicId, lang }: { publicId: string; lang: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    void shareInviteFlight(publicId, () => sendInvite(publicId)).then((outcome) => {
      if (!mounted) return;
      if (outcome === 'failed') setFailed(true);
      else navigate('/', { replace: true });
    });
    return () => {
      mounted = false;
    };
  }, [publicId, attempt]);

  if (failed) {
    return (
      <LoadError
        message={t(lang, 'failedInvite')}
        lang={lang}
        onRetry={() => {
          setFailed(false);
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
