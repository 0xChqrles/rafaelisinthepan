// THE ACCOUNT SCREEN (#204's UX rework, 2026-08-26): "is this account mine, and safe?"
//
// It exists because three different questions were sharing one scrolling screen — how others
// see me (the #188 editor), whether this account survives a lost phone (#204's email), and
// where it is signed in (#216's devices) — behind a chip that said EDIT, on a screen reached
// through a crown. ONE PURPOSE PER SCREEN: the editor keeps `/profile`, the email flow gets
// its own steps, and what is left here is the account itself:
//
//   THE ROW   the mark, the name, the saved ADDRESS under it, and EDIT — the identity as a
//             header, the UX research's own strip (user-decided 2026-08-26, rolling back
//             the hero: a page's identity is a masthead, not a monument). The address took
//             the place and the dress of the account's AGE on 2026-09-05 (user-decided:
//             "the email should be displayed at the location and with the style of the
//             account date of creation, and we should just drop the date").
//   STATS     the three numbers the account IS — the live STREAK (moved here from the
//             archive, user-decided 2026-08-28: a streak is a fact about the ACCOUNT, and
//             the archive is one language's calendar), the BEST it has ever held, and the
//             total DAYS. Across every supported language, which is what makes them the
//             same numbers the erase confirmation names when it asks whether to delete one.
//   SAVED     one lit button while the account is unsaved; the address under the name once
//             it is — a fact with no chip, because an account carries at most ONE address
//             and the server refuses a second, so a CHANGE control would promise what the
//             route refuses.
//   DEVICES   the #216 rows, acted on in place — and ONLY once an email is saved: an
//             unlinked account can only ever hold the one device reading the screen, and a
//             list of yourself is noise. (It is also half of the next rule.)
//
// **THE SCREEN IS THE SAME SCREEN FOR EVERY ACCOUNT** (user-decided 2026-08-28, widening
// 2026-08-26's rule rather than dropping it). The stats are drawn whatever state it is in
// — unsaved, brand new, nothing played — because a screen that hides what it has nothing
// to show of teaches a new player that the area is broken, where three zeros teach them
// what there is to fill.
//
// **AND NOTHING HERE STILL TELLS YOU WHETHER THE ACCOUNT IS DEPLOYED YET** (2026-08-26).
// The pseudonym and the mark are derived locally before deployment and stored as the
// account's first profile at it (`localIdentityDeploy`), so `useOwnFace` answers the same
// face either way; the STATS are zero for a tokenless device by the same fact that makes
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
import DeviceList from '../components/DeviceList';
import LangTitle from '../components/LangTitle';
import { HeaderLeft } from '../components/TopBar';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import {
  ACCOUNT_EMAIL_PATH,
  PRIVACY_PATH,
  PROFILE_PATH,
} from '../langs';
import { navigate } from '../routing';
import { loadAccountSummary, useAccountSummary } from '../state/account';
import { useAccountStats } from '../state/history';
import useToday from '../hooks/useToday';
import useUiLang from '../hooks/useUiLang';

export default function Account() {
  const lang = useUiLang();
  const identity = useDeviceIdentity();
  const { phase, summary } = useAccountSummary();
  const faceState = useOwnFace();
  const face = shownFace(faceState);
  // The masthead's placeholders breathe only while the read is OUT. A deleted account
  // (#204's 410) settles with no face, and a shimmer over it promises an arrival that is
  // not coming — that device is one private call away from the signed-out screen.
  const facePending = !faceSettled(faceState);
  // The day the streak is measured against, off the app's ONE day signal — which re-fires
  // at the 22:00 reset, so a screen left open overnight cannot keep showing an expired one.
  const stats = useAccountStats(useToday());

  // What this account IS — read once per account, and re-read when one arrives. A tokenless
  // device gets the answer without a request (#216): no token, no account, nothing to ask.
  useEffect(() => {
    loadAccountSummary();
  }, [identity]);

  const saved = summary?.email ?? null;
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
            {/* The saved ADDRESS, in the caption line under the name (2026-09-05, in the
                place the account's age held): a fact, no control — an account carries at
                most one address and the server refuses a second. */}
            {saved !== null && <span className="account-id-mail">{saved}</span>}
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
            where to go. THE SECOND DOOR — *I ALREADY HAVE AN ACCOUNT* / *SIGN IN TO
            ANOTHER ACCOUNT*, onto `/account/signin` — is GONE (user-decided 2026-09-05:
            "if you want to sign in again, just log out your session and sign in,
            everybody knows this flow"). Signing out is revoking this device in the list
            below; the signed-out screen's RECONNECT is the way to the returning door, and
            SAVE with a known address ADOPTS that account anyway. */}
        <div className="account-list">
          {phase === 'failed' && (
            <div className="account-load-error">
              <p className="status error">{t(lang, 'failedAccountLoad')}</p>
              <Button variant="secondary" onClick={() => loadAccountSummary(true)}>
                {t(lang, 'retry')}
              </Button>
            </div>
          )}
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

        {/* WHAT THE GAME KEEPS (#229) — a FOOTNOTE on the screen's BOTTOM EDGE, under the
            call (user-decided 2026-09-03, in two passes: first replacing a full-width row
            beside the account's own actions — "only 0.1% of the users will care and click on
            it… not hidden neither, just not in the middle of the screen with a big button" —
            then moved off the end of the CONTENT, which on a short screen is still the
            middle: "it's still in the middle of the screen"). Small, centred, in the
            secondary ink, with a finger's padding it does not show — exactly as visible as
            the interest in it. On a phone it parks on the edge and the call sits above it;
            that call gives up its exact bottom-edge alignment with MIX and INVITE on this one
            screen, on purpose. Not gated on the summary: what is stored is a fact about the
            game, true before this device has an account and while the read is still out. */}
        <div className="account-foot">
          <button type="button" className="account-foot-link" onClick={() => navigate(PRIVACY_PATH)}>
            {t(lang, 'privacyTitle')}
          </button>
        </div>
      </div>
    </>
  );
}
