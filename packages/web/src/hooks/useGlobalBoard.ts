// The day's GLOBAL board for the solved screen's GLOBAL tab: the anonymous `GET /board` widened
// with the player's PUBLIC id (their own window below the top-50 cut) — score rows and
// profiles only, no puzzle artifact. ONE read per mount, fenced by the identity epoch like
// every read about the player; a failure is silent and final for the mount (the GLOBAL tab
// simply does not show).
import { useEffect, useState } from 'react';
import type { Board } from '@whippin/shared';
import { boardUrl, parseBoard } from '../api';
import { identityEpoch, identityEpochOf, useDeviceIdentity } from '../identity';

// `null` while the read is out (or there is no identity to read for), else the board or
// `'failed'`.
export default function useGlobalBoard(lang: string, date: string): Board | 'failed' | null {
  const identity = useDeviceIdentity();
  const epoch = identity ? identityEpochOf(identity) : null;
  const key = identity ? `${epoch}:${lang}:${date}` : null;
  const [answer, setAnswer] = useState<{ key: string; board: Board | 'failed' } | null>(null);

  useEffect(() => {
    if (identity === null || key === null) return undefined;
    let cancelled = false;
    const current = () => !cancelled && identityEpoch() === epoch;
    (async () => {
      try {
        const response = await fetch(boardUrl(lang, date, identity.accountId));
        if (!current()) return;
        if (!response.ok) throw new Error(`board answered ${response.status}`);
        const board = parseBoard(await response.json());
        if (current()) setAnswer({ key, board });
      } catch {
        if (current()) setAnswer({ key, board: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed by the identity's epoch, the day and the language: one read each.
  }, [key]);

  return answer !== null && answer.key === key ? answer.board : null;
}
