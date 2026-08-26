// THE ACCOUNT SCREEN (#204's UX rework, 2026-08-26): "is this account mine, and safe?"
//
// It exists because three different questions were sharing one scrolling screen — how others
// see me (the #188 editor), whether this account survives a lost phone (#204's email), and
// where it is signed in (#216's devices) — behind a chip that said EDIT, on a screen reached
// through a crown. Even knowing the feature was there, you had to remember where it was
// hidden. ONE PURPOSE PER SCREEN: the editor keeps `/profile`, the email flow gets its own
// steps, and what is left here is the account itself.
//
// Three blocks, in the order a player cares about them:
//
//   WHO      the mark, the name, when the account began — and EDIT, out to the editor.
//   SAVED    one lit button while the account is unsaved; the ADDRESS ITSELF once it is.
//   DEVICES  the #216 rows, acted on in place.
//
// **A TOKENLESS DEVICE OPENS IT WITHOUT ASKING THE SERVER ANYTHING** (#216's no-private-fetch
// rule): the local placeholder seed already IS the face the leaderboard shows, the account is
// known-unsaved, and there are no device rows to list. SAVE is live either way — its tap is
// the account-deploying trigger, exactly as it was on the old editor.

import { useEffect } from 'react';
import { defaultAvatar } from '@whippin/shared';
import { useAccountFace } from '../components/AccountFace';
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
  const { summary } = useAccountSummary();
  const localSeed = useGameStore((s) => s.localSeed);
  const ensureLocalSeed = useGameStore((s) => s.ensureLocalSeed);
  const accountReturn = useGameStore((s) => s.profileReturn);
  const setProfileReturn = useGameStore((s) => s.setProfileReturn);

  // What this account IS — read once per account, and re-read when one arrives (the SAVE
  // tap's own deploy is such an arrival). A tokenless device gets the answer without a
  // request (#216): no token, no account, nothing to ask.
  useEffect(() => {
    loadAccountSummary();
  }, [identity]);

  // The placeholder a tokenless device wears — the leaderboard strip's own seed, so the two
  // screens can never show one visitor two faces.
  useEffect(() => {
    if (identity === null && localSeed === null) ensureLocalSeed();
  }, [identity, localSeed, ensureLocalSeed]);
  const publicId = identity?.accountId ?? localSeed;
  const face = useAccountFace(publicId, identity === null);
  const since = summary ? began(summary.createdAt, lang) : null;

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
        {/* WHO — a HERO, not a strip (user feedback 2026-08-26: the signed-out screen was
            showing the account off better than its own home). The mark centered at the
            signed-out screen's own size, the name under it at its weight, the account's age
            as the quiet line, EDIT as the one chip. The face holds its boxes until the read
            settles rather than flashing a pseudonym it may be about to correct (the
            leaderboard strip's finding). */}
        <div className="account-hero">
          {face && publicId ? (
            <Avatar avatar={face.avatar ?? defaultAvatar(publicId)} size={64} />
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

        {/* SAVED. Unsaved, this is the screen's one lit thing; saved, the ADDRESS is the
            status — no "saved as" prefix in front of something plainly an email. */}
        {summary?.email ? (
          <div className="account-row">
            <span className="account-row-value">{summary.email}</span>
            <button
              type="button"
              className="board-chip"
              onClick={() => navigate(ACCOUNT_EMAIL_PATH)}
            >
              {t(lang, 'accountChange')}
            </button>
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

        {/* DEVICES. Only with an account: a tokenless device has no rows to list, and
            asking would be a private read on a visit that never acted (#216). */}
        {identity !== null && <DeviceList lang={lang} />}
      </div>
    </>
  );
}
