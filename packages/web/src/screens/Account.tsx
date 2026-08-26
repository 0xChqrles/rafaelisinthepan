// THE ACCOUNT SCREEN (#204's UX rework, 2026-08-26): "is this account mine, and safe?"
//
// It exists because three different questions were sharing one scrolling screen — how others
// see me (the #188 editor), whether this account survives a lost phone (#204's email), and
// where it is signed in (#216's devices) — behind a chip that said EDIT, on a screen reached
// through a crown. ONE PURPOSE PER SCREEN: the editor keeps `/profile`, the email flow gets
// its own steps, the devices moved one door further to `/account/manage`, and what is left
// here is the account ITSELF, in two zones:
//
//   TOP     the face, the name, EDIT — the account, shown off the way the signed-out screen
//           shows it off, because this is its home.
//   BOTTOM  the one thing there is to DO: save it with an address, or — once it is saved —
//           the address itself with the way into managing it.
//
// **NOTHING HERE REVEALS WHETHER THE ACCOUNT EXISTS ON THE SERVER YET** (user-decided
// 2026-08-26). The pseudonym and the mark are derived locally from the persisted seed before
// deployment and stored as the account's first profile at it (`localIdentityDeploy`), so
// `useOwnFace` answers the same face either way; the devices and the account's age live
// behind MANAGE, which only a SAVED account reaches; and the action holds a skeleton while
// the summary is out rather than claiming UNSAVED before it knows (#211's explicit-loading
// rule — a guessed empty answer is a false claim). SAVE is live either way: its tap is the
// account-deploying trigger, exactly as it was on the old editor.

import { useEffect } from 'react';
import { defaultAvatar } from '@whippin/shared';
import { useOwnFace } from '../components/AccountFace';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import TopBar from '../components/TopBar';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import {
  ACCOUNT_EMAIL_PATH,
  ACCOUNT_MANAGE_PATH,
  PROFILE_PATH,
  pathForBoard,
  resolveHomeLang,
} from '../langs';
import { navigate } from '../routing';
import { loadAccountSummary, useAccountSummary } from '../state/account';
import { useGameStore } from '../state/gameStore';
import CloseIcon from '../assets/icons/close.svg?react';

export default function Account() {
  const lastLang = useGameStore((s) => s.lastLang);
  const lastMode = useGameStore((s) => s.lastMode);
  const lang = resolveHomeLang(lastLang, navigator.language);
  const identity = useDeviceIdentity();
  const { phase, summary } = useAccountSummary();
  const accountReturn = useGameStore((s) => s.profileReturn);
  const setProfileReturn = useGameStore((s) => s.setProfileReturn);
  const face = useOwnFace();

  // What this account IS — read once per account, and again when one arrives (the SAVE
  // tap's own deploy is such an arrival). A tokenless device gets the answer without a
  // request (#216): no token, no account, nothing to ask.
  useEffect(() => {
    loadAccountSummary();
  }, [identity]);

  // The action is UNKNOWN until the summary settles: offering SAVE while we do not yet know
  // whether it is already saved is the guessed-empty claim #211's rule forbids — and it
  // would flash SAVE and then swap to the address on every first visit of a linked player.
  const known = phase !== 'loading';

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
      <div className="account-screen account-page">
        {/* WHO. The face holds its boxes until the read settles rather than flashing a
            pseudonym it may be about to correct (the leaderboard strip's finding). */}
        <div className="account-hero">
          {face ? (
            <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={64} />
          ) : (
            <span className="account-hero-mark skeleton" aria-hidden="true" />
          )}
          {face ? (
            <span className="account-hero-name">{face.name}</span>
          ) : (
            <span className="skeleton skeleton-name" aria-hidden="true" />
          )}
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

        {/* The one thing to DO, on the screen's bottom edge — the board's INVITE shape. */}
        <div className="account-action">
          {!known && <span className="account-action-slot skeleton" aria-hidden="true" />}
          {known && summary?.email && (
            <div className="account-row">
              <span className="account-row-value">{summary.email}</span>
              {/* MANAGE, not CHANGE: an account carries at most ONE address and the server
                  refuses a second, so offering to change it was a promise the route would
                  break. What there IS to do with a saved account is manage it. */}
              <button
                type="button"
                className="board-chip"
                onClick={() => navigate(ACCOUNT_MANAGE_PATH)}
              >
                {t(lang, 'accountManage')}
              </button>
            </div>
          )}
          {known && !summary?.email && (
            <>
              <Button variant="primary" onClick={() => navigate(ACCOUNT_EMAIL_PATH)}>
                {t(lang, 'accountSave')}
              </Button>
              {/* The ONE line that earns its place: why a game wants an email is genuinely
                  not obvious, and it is said once, where the decision is made. */}
              <p className="account-note caption">{t(lang, 'accountSaveNote')}</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
