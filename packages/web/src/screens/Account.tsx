// THE ACCOUNT SCREEN (#204's UX rework, 2026-08-26): "is this account mine, and safe?"
//
// It exists because three different questions were sharing one scrolling screen — how others
// see me (the #188 editor), whether this account survives a lost phone (#204's email), and
// where it is signed in (#216's devices) — behind a chip that said EDIT, on a screen reached
// through a crown. ONE PURPOSE PER SCREEN: the editor keeps `/profile`, the email flow gets
// its own steps, and what is left here is the account itself:
//
//   THE ROW   the mark, the name, the account's age, and EDIT — the identity as a header,
//             the UX research's own strip (user-decided 2026-08-26, rolling back the hero:
//             a page's identity is a masthead, not a monument).
//   STATS     the three numbers the account IS — the live STREAK (moved here from the
//             archive, user-decided 2026-08-28: a streak is a fact about the ACCOUNT, and
//             the archive is one language's calendar), the BEST it has ever held, and the
//             total DAYS. Across every supported language, which is what makes them the
//             same numbers the erase confirmation names when it asks whether to delete one.
//   SAVED     one lit button while the account is unsaved; the ADDRESS ITSELF once it is —
//             a fact with no chip, because an account carries at most ONE address and the
//             server refuses a second, so a CHANGE control would promise what the route
//             refuses.
//   DEVICES   the #216 rows, acted on in place — and ONLY once an email is saved: an
//             unlinked account can only ever hold the one device reading the screen, and a
//             list of yourself is noise. (It is also half of the next rule.)
//
// **THE SCREEN IS THE SAME SCREEN FOR EVERY ACCOUNT** (user-decided 2026-08-28, widening
// 2026-08-26's rule rather than dropping it). The stats and the account's AGE are drawn
// whatever state it is in — unsaved, brand new, nothing played — because a screen that
// hides what it has nothing to show of teaches a new player that the area is broken, where
// three zeros and a date teach them what there is to fill.
//
// **AND NOTHING HERE STILL TELLS YOU WHETHER THE ACCOUNT IS DEPLOYED YET** (2026-08-26).
// The pseudonym and the mark are derived locally before deployment and stored as the
// account's first profile at it (`localIdentityDeploy`), so `useOwnFace` answers the same
// face either way; the AGE is the account's `createdAt` or — with no account yet — the
// local seed's own instant, which is honest about the identity on screen and is the one
// that gets deployed; the STATS are zero for a tokenless device by the same fact that makes
// them zero for a deployed one that has not played (#216: no token, no rows, no request);
// the DEVICES still appear only once SAVED, because an unlinked account can only ever hold
// the one device reading the screen; and the action holds its box while the summary is out
// rather than claiming UNSAVED before it knows (#211's explicit-loading rule). SAVE is live
// either way — its tap leads to the flow whose CONTINUE is the account-deploying trigger.

import { useEffect } from 'react';
import { defaultAvatar } from '@whippin/shared';
import { useOwnFace } from '../components/AccountFace';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import DeviceList from '../components/DeviceList';
import TopBar from '../components/TopBar';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import {
  ACCOUNT_EMAIL_PATH,
  ACCOUNT_SIGNIN_PATH,
  PROFILE_PATH,
  pathForBoard,
  resolveHomeLang,
} from '../langs';
import { navigate } from '../routing';
import { loadAccountSummary, useAccountSummary } from '../state/account';
import { useAccountStats } from '../state/history';
import { useGameStore } from '../state/gameStore';
import useToday from '../hooks/useToday';
import CloseIcon from '../assets/icons/close.svg?react';

// "since 12 aug" — the identity's own age, in the reader's locale. An unparseable or absent
// instant renders as NO line rather than a placeholder: the device list's rule, for the same
// reason (a label must not be able to fail the block it decorates).
function began(createdAt: string | null, lang: string): string | null {
  const at = createdAt === null ? NaN : Date.parse(createdAt);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(new Date(at));
}

export default function Account() {
  const lastLang = useGameStore((s) => s.lastLang);
  const lastMode = useGameStore((s) => s.lastMode);
  const lang = resolveHomeLang(lastLang, navigator.language);
  const identity = useDeviceIdentity();
  const { phase, summary } = useAccountSummary();
  const accountReturn = useGameStore((s) => s.profileReturn);
  const setProfileReturn = useGameStore((s) => s.setProfileReturn);
  const face = useOwnFace();
  const localSeedAt = useGameStore((state) => state.localSeedAt);
  // The day the streak is measured against, off the app's ONE day signal — which re-fires
  // at the 22:00 reset, so a screen left open overnight cannot keep showing an expired one.
  const stats = useAccountStats(useToday());

  // What this account IS — read once per account, and re-read when one arrives. A tokenless
  // device gets the answer without a request (#216): no token, no account, nothing to ask.
  useEffect(() => {
    loadAccountSummary();
  }, [identity]);

  const saved = summary?.email ?? null;
  // WHEN this identity began. The account's own instant once there is one; the local seed's
  // before that, which is honest about the face on screen and keeps the line from being the
  // one thing that tells a deployed device from a tokenless one.
  const since = began(summary?.createdAt ?? localSeedAt, lang);
  // The ACTION is unknown until the summary settles: offering SAVE while we do not yet know
  // whether it is already saved is the guessed-empty claim #211's rule forbids — it would
  // flash SAVE and swap it for the address on every visit of a linked player.
  const known = identity === null || phase === 'ready' || phase === 'failed';

  return (
    <>
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'accountTitle')}</span>}
        right={
          <button
            type="button"
            className="home-btn archive-close"
            aria-label={t(lang, 'ariaClose')}
            onClick={() => {
              setProfileReturn(null);
              navigate(accountReturn ?? pathForBoard(lang, lastMode ?? 'sentence'));
            }}
          >
            <CloseIcon className="ui-icon" aria-hidden />
          </button>
        }
      />
      <div className="account-screen">
        {/* THE ROW — the identity as the page's masthead. The face holds its boxes until
            the read settles rather than flashing a pseudonym it may be about to correct
            (the leaderboard strip's finding). */}
        <div className="account-id">
          {face ? (
            <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={48} />
          ) : (
            <span className="account-id-mark skeleton" aria-hidden="true" />
          )}
          <span className="account-id-text">
            {face ? (
              <span className="account-id-name">{face.name}</span>
            ) : (
              <span className="skeleton skeleton-name" aria-hidden="true" />
            )}
            {since && (
              <span className="account-id-since">{`${t(lang, 'accountSince')} ${since}`}</span>
            )}
          </span>
          <button
            type="button"
            className="board-chip"
            onClick={() => {
              // `/profile` is global, so the editor cannot read where it was opened from.
              // It comes back HERE, which is now the one door to it.
              setProfileReturn(null);
              navigate(PROFILE_PATH);
            }}
          >
            {t(lang, 'boardEdit')}
          </button>
        </div>

        {/* THE STATS — what this account IS, in the three numbers the server itself names
            when it asks whether to delete one. Drawn in EVERY state, zeros included: a
            screen that hides what it has nothing to show of reads as broken to the player
            who has just arrived, where three zeros and a date read as a thing to fill.
            Until the collections land the VALUES hold their boxes rather than claiming zero
            (#211: an unknown answer is never rendered as a claim) — and a tokenless device
            knows its rows are empty without asking, so it settles at zero with no request
            and no skeleton. */}
        <div className="account-stats">
          {[
            { key: 'streak', label: t(lang, 'streak'), value: stats.streak },
            { key: 'best', label: t(lang, 'statBest'), value: stats.best },
            { key: 'days', label: t(lang, 'statDays'), value: stats.days },
          ].map((stat) => (
            <div className="account-stat" key={stat.key}>
              <span className="account-stat-value">
                {stats.phase === 'ready' ? (
                  stat.value
                ) : (
                  <span
                    className={`account-stat-slot skeleton${
                      stats.phase === 'loading' ? '' : ' still'
                    }`}
                    aria-hidden="true"
                  />
                )}
              </span>
              <span className="account-stat-label">{stat.label}</span>
            </div>
          ))}
        </div>

        {/* SAVED. Unsaved, the lit button is the screen's one call; saved, the ADDRESS is
            the status — no prefix, no chip. Unknown holds the button's own box. */}
        {!known ? (
          <span className="account-action-slot skeleton" aria-hidden="true" />
        ) : saved !== null ? (
          <div className="account-row">
            <span className="account-row-value">{saved}</span>
          </div>
        ) : (
          <>
            <Button variant="primary" onClick={() => navigate(ACCOUNT_EMAIL_PATH)}>
              {t(lang, 'accountSave')}
            </Button>
            {/* The ONE line that earns its place: why a game wants an email is genuinely
                not obvious, and it is said once, where the decision is made. */}
            <p className="account-note caption">{t(lang, 'accountSaveNote')}</p>
          </>
        )}

        {/* DEVICES — only once SAVED: an unlinked account holds exactly the device reading
            this screen, and a list of yourself is noise. Multi-device only ever arrives
            through the email link. */}
        {saved !== null && identity !== null && <DeviceList lang={lang} />}

        {/* THE SECOND DOOR (#204's UX rework vol. 2). Saving an account and signing into
            another one are OPPOSITE acts, and until now this screen offered only the first
            — so a returning player was looking for a word that was not on screen, and had
            to guess that SAVE also meant "get it back" on the one screen where guessing
            wrong deletes something. It stays QUIET, never a second primary: most visitors
            here came to save.

            Its WORDS change with what it would cost, which is one fact this screen already
            holds. Unsaved, leaving destroys this account, so the door names the intention
            plainly and the flow states the price before a keystroke is spent. SAVED, the
            account stays reachable by its own address — leaving is reversible — so the door
            simply says what it does. It is held back until the summary settles, for the
            same reason the action above it is: a door whose meaning depends on an answer we
            do not have yet may not be drawn. */}
        {known && (
          <button
            type="button"
            className="link-quiet-btn account-door"
            onClick={() => navigate(ACCOUNT_SIGNIN_PATH)}
          >
            {t(lang, saved !== null ? 'accountSwitch' : 'accountHaveAccount')}
          </button>
        )}
      </div>
    </>
  );
}
