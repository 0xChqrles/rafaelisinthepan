// WHAT AN ACCOUNT IS WORTH, in the three numbers every surface that states one uses: the
// live STREAK, the BEST it has ever held, and its total DAYS (user-decided 2026-08-28).
//
// It is drawn in three places, for three different reasons, and they have to agree — a
// player who reads a streak of 12 on their account screen and is then offered a dialog
// saying 9 has been told the app does not know its own numbers:
//
//   /account            what this account IS — read from the private history collections.
//   the CROSSROADS      what a deletion is about to COST, or what a switch leaves behind.
//   the RECOVERY ending what signing back in just HANDED BACK — the evidence for the claim
//                       "we found your account", and the first thing a returning player
//                       checks.
//
// The last two are the SERVER's own reading (`accountStakes`), which is the same reading
// `useAccountStats` performs on the client, over the same collections. That is why
// `bestStreak` sits in `@whippin/shared` beside `currentStreak`.
//
// **THE VALUES ARE THE ONLY THING EVER WITHHELD.** Labels and layout are always drawn — a
// screen that hides what it has nothing to show of reads as broken to the player who has
// just arrived, where three zeros read as a thing to fill — and a value that has not
// arrived holds its box rather than claiming zero (#211: an unknown answer is never
// rendered as a claim). The box BREATHES only while a read is in flight; a failure rests
// still, since breathing promises an answer that is no longer coming.

import { t } from '../i18n';

export interface AccountStatsValues {
  streak: number;
  best: number;
  days: number;
}

export default function AccountStats({
  lang,
  stats,
  // `null` is "not yet known" — the boxes are held. A caller holding a settled answer (the
  // server's, on a dialog or an ending) passes the values and nothing breathes.
  loading = false,
}: {
  lang: string;
  stats: AccountStatsValues | null;
  loading?: boolean;
}) {
  const cells = [
    { key: 'streak', label: t(lang, 'streak'), value: stats?.streak },
    { key: 'best', label: t(lang, 'statBest'), value: stats?.best },
    { key: 'days', label: t(lang, 'statDays'), value: stats?.days },
  ];
  return (
    <div className="account-stats">
      {cells.map((cell) => (
        <div className="account-stat" key={cell.key}>
          <span className="account-stat-value">
            {cell.value === undefined ? (
              <span
                className={`account-stat-slot skeleton${loading ? '' : ' still'}`}
                aria-hidden="true"
              />
            ) : (
              cell.value
            )}
          </span>
          <span className="account-stat-label">{cell.label}</span>
        </div>
      ))}
    </div>
  );
}
