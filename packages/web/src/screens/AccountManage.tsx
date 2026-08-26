// MANAGING A SAVED ACCOUNT (#204's UX rework, 2026-08-26): where it is signed in, and — when
// #207 lands — the way to delete it.
//
// It is one door deeper than `/account` because of what that screen is FOR: a player opens it
// to see who they are and to make sure they cannot lose it. Where they are signed in is a
// different question, asked far less often, and it is a LIST rather than a statement — the
// two do not belong on one screen (the rework's whole rule).
//
// **It is reached only from a SAVED account's MANAGE chip**, which is why it can state the
// account's age without becoming a tell: an account with an address has, by definition, been
// deployed. A device that arrives here holding none — a deep link, a sign-out landing — is
// sent back to `/account`, where everything it can honestly be told already is.

import { useEffect } from 'react';
import { defaultAvatar } from '@whippin/shared';
import { useOwnFace } from '../components/AccountFace';
import Avatar from '../components/Avatar';
import DeviceList from '../components/DeviceList';
import TopBar from '../components/TopBar';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import { ACCOUNT_PATH, resolveHomeLang } from '../langs';
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

export default function AccountManage() {
  const lastLang = useGameStore((s) => s.lastLang);
  const lang = resolveHomeLang(lastLang, navigator.language);
  const identity = useDeviceIdentity();
  const { summary } = useAccountSummary();
  const face = useOwnFace();

  useEffect(() => {
    loadAccountSummary();
  }, [identity]);

  // Nothing to manage without an account. `replace`, so a back tap leaves the area rather
  // than bouncing through a screen that will send them straight back.
  useEffect(() => {
    if (identity === null) navigate(ACCOUNT_PATH, { replace: true });
  }, [identity]);

  const since = summary ? began(summary.createdAt, lang) : null;

  return (
    <>
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'accountManageTitle')}</span>}
        right={
          <button
            type="button"
            className="home-btn archive-close"
            aria-label={t(lang, 'ariaClose')}
            onClick={() => navigate(ACCOUNT_PATH)}
          >
            <CloseIcon className="ui-icon" aria-hidden />
          </button>
        }
      />
      <div className="account-screen">
        {/* EVERY screen of the area leads with the face — the home, the flow's steps, its
            endings, and this one. It says WHOSE devices these are, and it is what the
            account's own age finally hangs off: a line floating alone above a list was the
            orphan-text shape this whole rework is against. The age is the one account
            DETAIL that is not a tell, since only a SAVED account reaches this screen. */}
        <div className="account-hero">
          {face ? (
            <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={64} />
          ) : (
            <span className="account-hero-mark skeleton" aria-hidden="true" />
          )}
          <span className="account-hero-id">
            {face ? (
              <span className="account-hero-name">{face.name}</span>
            ) : (
              <span className="skeleton skeleton-name" aria-hidden="true" />
            )}
            {since && (
              <span className="account-hero-since">{`${t(lang, 'accountSince')} ${since}`}</span>
            )}
          </span>
        </div>
        {identity !== null && <DeviceList lang={lang} />}
      </div>
    </>
  );
}
