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
//   SAVED     one lit button while the account is unsaved; the ADDRESS ITSELF once it is —
//             a fact with no chip, because an account carries at most ONE address and the
//             server refuses a second, so a CHANGE control would promise what the route
//             refuses.
//   DEVICES   the #216 rows, acted on in place — and ONLY once an email is saved: an
//             unlinked account can only ever hold the one device reading the screen, and a
//             list of yourself is noise. (It is also half of the next rule.)
//
// **NOTHING HERE TELLS YOU WHETHER THE ACCOUNT IS DEPLOYED YET** (user-decided 2026-08-26).
// The pseudonym and the mark are derived locally before deployment and stored as the
// account's first profile at it (`localIdentityDeploy`), so `useOwnFace` answers the same
// face either way; the age and the devices appear only once SAVED, which both a tokenless
// and a deployed-unsaved device equally are not; and the action holds its box while the
// summary is out rather than claiming UNSAVED before it knows (#211's explicit-loading
// rule). SAVE is live either way — its tap leads to the flow whose CONTINUE is the
// account-deploying trigger.

import { useEffect } from 'react';
import { defaultAvatar } from '@whippin/shared';
import { useOwnFace } from '../components/AccountFace';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import DeviceList from '../components/DeviceList';
import TopBar from '../components/TopBar';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import { ACCOUNT_EMAIL_PATH, PROFILE_PATH, pathForBoard, resolveHomeLang } from '../langs';
import { navigate } from '../routing';
import { loadAccountSummary, useAccountSummary } from '../state/account';
import { useGameStore } from '../state/gameStore';
import CloseIcon from '../assets/icons/close.svg?react';

// "since 12 aug" — the account's own age, in the reader's locale. An unparseable or absent
// instant renders as NO line rather than a placeholder: the device list's rule, for the same
// reason (a label must not be able to fail the block it decorates).
function began(createdAt: string, lang: string): string | null {
  const at = Date.parse(createdAt);
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

  // What this account IS — read once per account, and re-read when one arrives. A tokenless
  // device gets the answer without a request (#216): no token, no account, nothing to ask.
  useEffect(() => {
    loadAccountSummary();
  }, [identity]);

  const saved = summary?.email ?? null;
  // The age joins the row only once the account is SAVED — before that it would be the one
  // line telling a deployed device apart from a tokenless one.
  const since = saved !== null && summary ? began(summary.createdAt, lang) : null;
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
      </div>
    </>
  );
}
