// WHAT AN ACCOUNT IS WORTH, in the three numbers every surface that states one uses: the
// live STREAK, the BEST it has ever held, and its total DAYS (user-decided 2026-08-28).
//
// They are drawn in three places, for three different reasons, and they have to agree — a
// player who reads a streak of 12 on their account screen and is then offered a dialog
// saying 9 has been told the app does not know its own numbers:
//
//   /account            what this account IS — the RECORD (`record/Record.tsx`): the streak
//                       as the screen's subject, BEST and DAYS beside it, read from the
//                       private history collections.
//   the CROSSROADS      what a deletion is about to COST, or what a switch leaves behind.
//   the RECOVERY ending what signing back in just HANDED BACK — the evidence for the claim
//                       "we found your account", and the first thing a returning player
//                       checks.
//
// This component is the last two: the ROW. The flow's numbers are the SERVER's own reading
// (`accountStakes`), which is the same reading `useAccountStats` performs on the client, over
// the same collections — that is why `bestStreak` sits in `@whippin/shared` beside
// `currentStreak`.
//
// THE ROW IS QUIET: the three numbers in the game's pixel face, either side of the boards'
// stippled rails, labels in the chrome's tracked mono — no foil, no flame, no burst, no
// charge. On the crossroads the numbers are a PRICE, and destruction never glows. A caller
// that hands numbers BACK (the recovery ending) may ask them to `land` on the count's reels;
// nothing else moves.
//
// **THE VALUES ARE THE ONLY THING EVER WITHHELD.** Labels and layout are always drawn — a
// screen that hides what it has nothing to show of reads as broken to the player who has
// just arrived, where three zeros read as a thing to fill — and a value that has not
// arrived holds its box as the stippled slate rather than claiming zero (#211: an unknown
// answer is never rendered as a claim). The box BREATHES only while a read is in flight; a
// failure rests still, since breathing promises an answer that is no longer coming.

import type { CSSProperties } from 'react';
import { t } from '../i18n';
import ReelNumber from './ReelNumber';

// The recovery ending's landing: the board lines' compressed run.
const LAND_RUN_MS = 700;
const LAND_STAGGER_MS = 90;

export interface AccountStatsValues {
  streak: number;
  best: number;
  days: number;
}

// A VALUE NOT YET KNOWN: its box as the slate's 2px checker (the boards' own skeleton, never a
// grey rounded block) — breathing in hard 160ms steps while a read is out, the still 50%
// checker once one has failed. `/account`'s record holds its count and its two numbers in it.
export function StatSlot({
  phase,
  className = '',
  style,
}: {
  phase: 'loading' | 'failed' | 'ready';
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`stat-slot${phase === 'loading' ? ' breathing' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden="true"
    />
  );
}

export default function AccountStats({
  lang,
  stats,
  // `null` is "not yet known" — the boxes are held. A caller holding a settled answer (the
  // server's, on a dialog or an ending) passes the values and nothing breathes.
  loading = false,
  // The numbers LAND on the count's reels as they mount, left to right — for a surface that is
  // handing them back (the recovery ending). Off by default: the crossroads stays still.
  land = false,
}: {
  lang: string;
  stats: AccountStatsValues | null;
  loading?: boolean;
  land?: boolean;
}) {
  const cells = [
    { key: 'streak', label: t(lang, 'streak'), value: stats?.streak },
    { key: 'best', label: t(lang, 'statBest'), value: stats?.best },
    { key: 'days', label: t(lang, 'statDays'), value: stats?.days },
  ];
  return (
    <div className="account-stats">
      {cells.map((cell, i) => (
        <div className="account-stat" key={cell.key}>
          <span className="account-stat-value">
            {cell.value === undefined ? (
              <StatSlot phase={loading ? 'loading' : 'failed'} />
            ) : (
              <ReelNumber
                value={cell.value}
                delayMs={land ? i * LAND_STAGGER_MS : 0}
                runMs={land ? LAND_RUN_MS : 0}
              />
            )}
          </span>
          <span className="account-stat-label">{cell.label}</span>
        </div>
      ))}
    </div>
  );
}
