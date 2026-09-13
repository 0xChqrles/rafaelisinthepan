import { useEffect, useRef, useState } from 'react';
import { dateForDayNumber, type GroupStanding } from '@whippin/shared';
import { boardUrl, parseStandings, postBoardBody } from '../api';
import {
  deviceIdentity,
  identityEpoch,
  identityEpochOf,
  identityScopeRevision,
} from '../identity';
import type { Mode } from '../langs';

// The solved screen's STANDING (#271): where this finished score sits today in ONE of the
// player's groups — "2nd of 7 today" — a plain READ once the SERVER holds the round
// (`solved` for a sentence round, `submitted` for a word run), which is what keeps it from
// landing before the score row it is looking for exists.
//
// ONE request answers every group (`POST /board {token, standing: true}`), and the screen
// picks ONE line from it: the group LAST OPENED on the leaderboard when the player stands
// in it, else the BEST standing (user-decided 2026-09-07). A device in no group, a round
// with no recorded score (late, capped) and a device with no identity all draw nothing.
//
// EVERY failure is silent by decision: the solved screen simply shows no standing, never
// an error.
export type GroupStandingState = GroupStanding | 'pending' | null;

// The group last opened if the player stands in it, else the best: the lowest rank, and
// among equal ranks the larger field (a 2nd of 7 says more than a 2nd of 2); the server's
// own order last, so two reads never swap the line.
export function pickStanding(
  standings: readonly GroupStanding[],
  lastGroupId: string | null,
): GroupStanding | null {
  const last = lastGroupId === null ? undefined : standings.find((row) => row.group === lastGroupId);
  if (last) return last;
  let best: GroupStanding | null = null;
  for (const row of standings) {
    if (best === null || row.rank < best.rank || (row.rank === best.rank && row.of > best.of)) {
      best = row;
    }
  }
  return best;
}

// One browser-session conversation per round, shared across COMPONENT lifetimes (the
// `activeScoreFlights` pattern): a remount subscribes to the same promise rather than
// firing a second read; settled work leaves the map so a later visit reads fresh.
const activeStandingFlights = new Map<string, Promise<GroupStanding[] | null>>();

export function shareStandingFlight(
  key: string,
  start: () => Promise<GroupStanding[] | null>,
): Promise<GroupStanding[] | null> {
  const existing = activeStandingFlights.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      return await start();
    } catch {
      return null;
    }
  })();
  activeStandingFlights.set(key, promise);
  void promise.then(() => {
    if (activeStandingFlights.get(key) === promise) activeStandingFlights.delete(key);
  });
  return promise;
}

// Exported for the contract test; callers use the hook below.
export async function readStandings(
  mode: Mode,
  lang: string,
  date: string,
): Promise<GroupStanding[] | null> {
  const identity = deviceIdentity();
  if (!identity) return null;
  const epoch = identityEpochOf(identity);
  const response = await postBoardBody(boardUrl(lang, date, mode), {
    token: identity.token,
    standing: true,
  });
  if (identityEpoch() !== epoch) return null;
  if (!response.ok) return null;
  const standings = parseStandings(await response.json());
  if (identityEpoch() !== epoch) return null;
  return standings;
}

export default function useGroupStanding({
  finished,
  mode,
  lang,
  dayNumber,
  lastGroupId,
}: {
  // The round is over AND THE SERVER HOLDS IT.
  finished: boolean;
  mode: Mode;
  lang: string;
  dayNumber: number;
  lastGroupId: string | null;
}): GroupStandingState {
  const [standings, setStandings] = useState<GroupStanding[] | 'pending' | null>(null);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!finished) {
      keyRef.current = null;
      setStandings(null);
      return undefined;
    }
    const key = `${identityScopeRevision()}:${mode}:${lang}:${dayNumber}`;
    if (keyRef.current !== key) {
      keyRef.current = key;
      setStandings('pending');
    }
    const promise = shareStandingFlight(key, () =>
      readStandings(mode, lang, dateForDayNumber(dayNumber)),
    );
    let cancelled = false;
    void promise.then((result) => {
      if (!cancelled) setStandings(result);
    });
    return () => {
      cancelled = true;
    };
  }, [finished, mode, lang, dayNumber]);

  if (standings === 'pending' || standings === null) return standings;
  return pickStanding(standings, lastGroupId);
}
