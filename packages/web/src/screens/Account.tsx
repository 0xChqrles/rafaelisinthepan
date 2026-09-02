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
import { faceSettled, shownFace, useOwnFace } from '../components/AccountFace';
import AccountStats from '../components/AccountStats';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import ChevronRightIcon from '../assets/icons/chevron-right.svg?react';
import DeviceList from '../components/DeviceList';
import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import {
  ACCOUNT_EMAIL_PATH,
  ACCOUNT_SIGNIN_PATH,
  PRIVACY_PATH,
  PROFILE_PATH,
  resolveHomeLang,
} from '../langs';
import { navigate } from '../routing';
import { loadAccountSummary, useAccountSummary } from '../state/account';
import { useAccountStats } from '../state/history';
import { useGameStore } from '../state/gameStore';
import useToday from '../hooks/useToday';

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
  const lang = resolveHomeLang(lastLang, navigator.language);
  const identity = useDeviceIdentity();
  const { phase, summary } = useAccountSummary();
  const faceState = useOwnFace();
  const face = shownFace(faceState);
  // The masthead's placeholders breathe only while the read is OUT. A deleted account
  // (#204's 410) settles with no face, and a shimmer over it promises an arrival that is
  // not coming — that device is one private call away from the signed-out screen.
  const facePending = !faceSettled(faceState);
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
  const known = identity === null || phase === 'ready' || summary !== null;
  const accountUnknown = phase === 'failed' && summary === null;

  return (
    <>
      {/* A PLACE, not a step (2026-08-31): the header's fixed row is here too, with the
          FACE lit, and leaving is tapping any other key — so the left slot carries the
          screen's plain name rather than a back control (the steps INSIDE the area, the
          editor and the email doors, keep theirs). Nothing remembers where this screen
          was opened from any more: every place is one tap away in the row. */}
      <HeaderLeft>
        <LangTitle lang={lang} title={t(lang, 'accountTitle')} />
      </HeaderLeft>
      <div className="account-screen">
        {/* THE ROW — the identity as the page's masthead. The face holds its boxes until
            the read settles rather than flashing a pseudonym it may be about to correct
            (the leaderboard strip's finding). */}
        <div className="account-id">
          {face ? (
            <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={48} />
          ) : (
            <span
              className={`account-id-mark${facePending ? ' skeleton' : ''}`}
              aria-hidden="true"
            />
          )}
          <span className="account-id-text">
            {face ? (
              <span className="account-id-name">{face.name}</span>
            ) : (
              facePending && <span className="skeleton skeleton-name" aria-hidden="true" />
            )}
            {since && (
              <span className="account-id-since">{`${t(lang, 'accountSince')} ${since}`}</span>
            )}
          </span>
          <button
            type="button"
            className="board-chip"
            onClick={() => navigate(PROFILE_PATH)}
          >
            {t(lang, 'boardEdit')}
          </button>
        </div>

        {/* THE STATS — what this account IS, in the three numbers the server itself names
            when it asks whether to delete one, and the recovery ending prints when it hands
            one back (`components/AccountStats` holds the reasoning). */}
        <AccountStats
          lang={lang}
          stats={stats.phase === 'ready' ? stats : null}
          loading={stats.phase === 'loading'}
        />

        {/* WHAT THERE IS TO DO WITH THIS ACCOUNT — as ROWS, one grammar (proposed
            2026-09-02 on the user's review: "a bunch of primary button, label, secondary
            button with a different width, with different gaps and sizings, all of it stuck
            near the stats"). Every action is a full-width row in the device list's own
            dress — a hairline glass box, a label, a chevron pointing where it leads — so
            the screen reads top-down as one settings page: who you are, what you hold,
            where to go. The saved address is a row too, a fact rather than a control (no
            chevron); the door to another account is a row that leads somewhere.
            Unknown holds a row's box, so nothing moves when the summary lands and nothing
            claims "unsaved" before it knows (#211's explicit-loading rule). */}
        <div className="account-list">
          {phase === 'failed' && (
            <div className="account-load-error">
              <p className="status error">{t(lang, 'failedAccountLoad')}</p>
              <Button variant="secondary" onClick={() => loadAccountSummary(true)}>
                {t(lang, 'retry')}
              </Button>
            </div>
          )}
          {!known ? (
            <span className="account-link skeleton" aria-hidden="true" />
          ) : accountUnknown ? null : (
            <>
              {saved !== null && (
                <div className="account-link static">
                  <span className="account-link-value">{saved}</span>
                </div>
              )}
              {/* THE SECOND DOOR (#204's UX rework vol. 2). Saving an account and signing
                  into another one are OPPOSITE acts; a returning player was looking for a
                  word that was not on screen. Its WORDS change with what it would cost:
                  unsaved, leaving destroys this account, so the door names the intention
                  plainly; saved, the account stays reachable by its own address, so the
                  door simply says what it does. */}
              <button
                type="button"
                className="account-link"
                onClick={() => navigate(ACCOUNT_SIGNIN_PATH)}
              >
                <span className="account-link-label">
                  {t(lang, saved !== null ? 'accountSwitch' : 'accountHaveAccount')}
                </span>
                <ChevronRightIcon className="ui-icon" aria-hidden />
              </button>
            </>
          )}
          {/* WHAT THE GAME KEEPS (#229) — a row like the others, because it answers this
              screen's own question from the other side: not "is this account mine" but
              "what does holding one cost me". It is NOT gated on the summary the way the
              rows above are: what is stored is a fact about the game, true before this
              device has an account and while the read is still out, so holding it back
              would be a screen withholding the one thing on it that never has to wait. */}
          <button
            type="button"
            className="account-link"
            onClick={() => navigate(PRIVACY_PATH)}
          >
            <span className="account-link-label">{t(lang, 'privacyTitle')}</span>
            <ChevronRightIcon className="ui-icon" aria-hidden />
          </button>
        </div>

        {/* DEVICES — its own SECTION, after everything there is to DO with this account
            (2026-08-30). ONLY once SAVED: an unlinked account holds exactly the device
            reading this screen, and a list of yourself is noise. */}
        {saved !== null && identity !== null && <DeviceList lang={lang} />}

        {/* THE ONE CALL, on the screen's BOTTOM EDGE — where every screen's one big action
            sits (the tutorial's MIX, the board's INVITE, both gates' PLAY), in exactly
            their geometry, so it is the SAME button in the SAME place from screen to
            screen. Only while UNSAVED: saved, there is nothing left to call for, and the
            rows above are the whole page. The ONE line that earns its place stands over
            it: why a game wants an email is genuinely not obvious, and it is said once,
            where the decision is made. */}
        {known && !accountUnknown && saved === null && (
          <div className="account-cta">
            <p className="account-note caption">{t(lang, 'accountSaveNote')}</p>
            <button
              type="button"
              className="mix-btn"
              onClick={() => navigate(ACCOUNT_EMAIL_PATH)}
            >
              {t(lang, 'accountSave')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
