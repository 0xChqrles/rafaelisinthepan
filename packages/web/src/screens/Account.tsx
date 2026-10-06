// THE ACCOUNT SCREEN (#204's UX rework, 2026-08-26): "is this account mine, and safe?"
//
// It exists because three different questions were sharing one scrolling screen — how others
// see me (the #188 editor), whether this account survives a lost phone (#204's email), and
// where it is signed in (#216's devices) — behind a chip that said EDIT, on a screen reached
// through a crown. ONE PURPOSE PER SCREEN: the editor keeps `/profile`, the email flow gets
// its own steps, and what is left here is the account itself:
//
//   THE ROW   the mark, the name, the saved ADDRESS under it — the identity as the page's
//             MASTHEAD (a page's identity is a masthead, not a monument), standing STILL:
//             nothing in it is framed but its one key, the pixel PENCIL in the corner
//             brackets a tappable thing wears, the door to the editor. The address took
//             the place and the dress of the account's AGE (user-decided 2026-09-05); the
//             words land once both their reads have, so nothing in the row moves after.
//   RECORD    the three numbers the account IS, as the screen's SUBJECT (`record/Record`):
//             the live STREAK in the streak celebration's own language — its flame over the
//             count, the week as the chain under it, today's link in foil once played —
//             with the BEST it has ever held and the total DAYS beside the rail. Across
//             every supported language, which is what makes them the same numbers the
//             erase confirmation names when it asks whether to delete one.
//   SAVED     one lit button while the account is unsaved; the address under the name once
//             it is — a fact with no chip, because an account carries at most ONE address
//             and the server refuses a second, so a CHANGE control would promise what the
//             route refuses.
//   DEVICES   the #216 lines, acted on in place — and ONLY once an email is saved: an
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
// the one device reading the screen; and the action's room is HELD as stippled slate while the
// summary is out rather than claiming UNSAVED before it knows (#211's explicit-loading rule).
// SAVE is live either way — its tap leads to the flow whose CONTINUE is the account-deploying
// trigger.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { RecordSize } from '../components/record/scene';
import { defaultAvatar } from '@whippin/shared';
import { faceSettled, shownFace, useOwnFace } from '../components/AccountFace';
import { StatSlot } from '../components/AccountStats';
import Avatar from '../components/Avatar';
import AddressLine from '../components/AddressLine';
import DeviceList from '../components/DeviceList';
import LangTitle from '../components/LangTitle';
import Record from '../components/record/Record';
import { handOffMark } from '../components/markHandoff';
import { HeaderLeft } from '../components/TopBar';
import PencilIcon from '../assets/icons/pencil.svg?react';
import { useDeviceIdentity } from '../identity';
import { t } from '../i18n';
import {
  ACCOUNT_EMAIL_PATH,
  PRIVACY_PATH,
  PROFILE_PATH,
} from '../langs';
import { navigate } from '../routing';
import { loadAccountSummary, useAccountSummary } from '../state/account';
import { useAccountStats, useAccountWeek } from '../state/history';
import useToday from '../hooks/useToday';
import useUiLang from '../hooks/useUiLang';

// THE MASTHEAD'S MARK: 50px, five whole pixels a cell — never a size between two of them.
const MARK_PX = 50;

// THE RECORD'S SIZE, off the screen's height: on a TALL phone the count one whole size up — the
// free height spent on the subject rather than left as a band of nothing; a phone only, since a
// desktop column has no bottom edge to fill and the size would push its footnote out — and on
// a SHORT screen (an iPhone SE's 667px and under) one size down, two on a TINY one, so the
// unsaved page's call still stands above the edge. The queries are made once; the hook only
// reads them.
const SIZE_QUERIES: readonly (readonly [RecordSize, string])[] = [
  ['tiny', '(max-height: 600px)'],
  ['short', '(max-height: 740px)'],
  ['tall', '(max-width: 640px) and (min-height: 800px)'],
];
const sizeQueries =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? SIZE_QUERIES.map(([size, query]) => [size, window.matchMedia(query)] as const)
    : [];
const subscribeSize = (change: () => void) => {
  for (const [, query] of sizeQueries) query.addEventListener('change', change);
  return () => {
    for (const [, query] of sizeQueries) query.removeEventListener('change', change);
  };
};
const recordSizeNow = (): RecordSize => sizeQueries.find(([, query]) => query.matches)?.[0] ?? 'normal';
function useRecordSize(): RecordSize {
  return useSyncExternalStore(subscribeSize, recordSizeNow);
}

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
  const today = useToday();
  const stats = useAccountStats(today);
  // The week the streak runs in — the record's chain — off the same collections, this
  // screen's own language first (a tie between two languages' runs goes to it).
  const week = useAccountWeek(today, lang);
  const size = useRecordSize();

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
  // THE MASTHEAD'S WORDS LAND ONCE, with both their facts: the name (the face) and whether an
  // address goes under it (the summary — or its failed read, which leaves the name alone). The
  // row is centred on the mark either way — the name alone, or name and address as one block
  // — so a row that printed the name before it knew would have to move it when an address
  // landed. Once landed they STAY for that face: a RETRY of a failed read leaves the name
  // printed while it is out, and only the address can arrive under it.
  const landedFor = useRef<string | null>(null);
  const words = face !== null && (known || phase === 'failed' || landedFor.current === face.publicId);
  if (words) landedFor.current = face.publicId;

  // THE DOOR TO THE EDITOR (the pencil key) hands the MARK's on-screen box over, so the
  // editor's canvas grows out of exactly where the mark stood (`markHandoff`).
  const markRef = useRef<HTMLSpanElement>(null);
  const handedAvatar = face ? (face.avatar ?? defaultAvatar(face.publicId)) : null;
  const openEditor = useCallback(() => {
    const rect = markRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0) handOffMark(rect, handedAvatar);
    navigate(PROFILE_PATH);
  }, [handedAvatar]);

  return (
    <>
      {/* A PLACE, not a step (2026-08-31): the header's fixed row is here too, with the
          FACE lit, and leaving is tapping any other key — so the left slot carries the
          screen's plain name rather than a back control (the steps INSIDE the area, the
          editor and the email doors, keep theirs). */}
      <HeaderLeft>
        <LangTitle lang={lang} title={t(lang, 'accountTitle')} />
      </HeaderLeft>
      <div className="account-screen account-page">
        {/* THE MASTHEAD — the identity, STILL: a plain row on one axis, the mark at 50px
            (five whole pixels a cell), the name in the boards' face with the saved address
            under it, the pair centred on the mark (the name alone when there is none), and,
            at the trailing edge, the ONE thing in the row that is tapped: the pixel pencil
            in a tappable thing's corner brackets, the editor's door (its name said to a
            screen reader; the pencil says it on screen). Nothing else is framed, so nothing
            else reads as editable. The boxes hold until their reads settle rather than
            flashing a pseudonym it may be about to correct (the leaderboard strip's
            finding), and the words land ONCE (`words`), so nothing moves after. */}
        <div className="account-id">
          <span ref={markRef} className="account-id-mark">
            {face ? (
              <Avatar avatar={face.avatar ?? defaultAvatar(face.publicId)} size={MARK_PX} sharp />
            ) : (
              facePending && <StatSlot phase="loading" />
            )}
          </span>
          <span className="account-id-text">
            {words ? (
              <span className="account-id-name">{face.name}</span>
            ) : (
              <span className={`account-id-name-slot${facePending || face ? '' : ' gone'}`} aria-hidden="true" />
            )}
            {/* The saved ADDRESS (2026-09-05, in the place the account's age held): a fact,
                no control — an account carries at most one address and the server refuses a
                second. It prints only once SAVED. */}
            {words && saved !== null && (
              <span className="account-id-mail">
                <AddressLine address={saved} className="account-id-mail-line" />
              </span>
            )}
          </span>
          <button
            type="button"
            className="account-edit"
            aria-label={t(lang, 'boardEdit')}
            title={t(lang, 'boardEdit')}
            onClick={openEditor}
          >
            <PencilIcon className="ui-icon" aria-hidden="true" />
          </button>
        </div>

        {/* THE RECORD — what this account has DONE, as the screen's subject (`record/`): the
            streak in the celebration's own language, BEST and DAYS beside the rail — the
            three numbers the server itself names when it asks whether to delete one. */}
        <Record
          lang={lang}
          stats={stats.phase === 'ready' ? stats : null}
          week={stats.phase === 'ready' ? week : null}
          phase={stats.phase === 'ready' ? 'ready' : stats.phase === 'failed' ? 'failed' : 'loading'}
          size={size}
          onRetry={stats.retry}
        />

        {/* What the account is SAVED as could not be read: said quietly, and the quiet word in
            a tappable thing's brackets asks again (the call itself waits — it may not apply). */}
        {phase === 'failed' && (
          <div className="account-load-error">
            <p className="account-load-error-line" role="status">
              {t(lang, 'failedAccountLoad')}
            </p>
            <button type="button" className="quiet-btn" onClick={() => loadAccountSummary(true)}>
              {t(lang, 'retry')}
            </button>
          </div>
        )}

        {/* DEVICES — after the record, ONLY once SAVED: an unlinked account holds exactly the
            device reading this screen, and a list of yourself is noise. No caption: the
            lines say what they are. */}
        {saved !== null && identity !== null && <DeviceList lang={lang} />}

        {/* THE ONE CALL, on the screen's BOTTOM EDGE — where every screen's one big action
            sits (the tutorial's MIX, the board's INVITE, both gates' PLAY), in exactly
            their geometry. Only while UNSAVED: saved, there is nothing left to call for. The
            ONE line that earns its place stands over it: why a game wants an email is
            genuinely not obvious, and it is said once, where the decision is made.
            WHILE THE SUMMARY IS OUT its room is HELD at its final size — the note's lines as
            stippled rails (its words laid out unseen, so each rail is its line's length), the
            button's box as the house hold — so the footnote under it never moves when the call
            lands; the call then takes the hold's own box in place. */}
        {!accountUnknown && saved === null && (
          <div className={`account-cta${known ? '' : ' holding'}`} aria-hidden={known ? undefined : true}>
            <p className="account-note caption">
              {known ? t(lang, 'accountSaveNote') : <span className="account-cta-rail">{t(lang, 'accountSaveNote')}</span>}
            </p>
            {known ? (
              <button
                type="button"
                className="mix-btn"
                onClick={() => navigate(ACCOUNT_EMAIL_PATH)}
              >
                {t(lang, 'accountSave')}
              </button>
            ) : (
              <span className="mix-btn link-hold waiting">{t(lang, 'accountSave')}</span>
            )}
          </div>
        )}

        {/* WHAT THE GAME KEEPS (#229) — a FOOTNOTE on the screen's BOTTOM EDGE, under the
            call (user-decided 2026-09-03: "only 0.1% of the users will care and click on
            it… not hidden neither, just not in the middle of the screen with a big button").
            Small, centred, in the secondary ink, with a finger's padding it does not show.
            Not gated on the summary: what is stored is a fact about the game. */}
        <div className="account-foot">
          <button type="button" className="account-foot-link" onClick={() => navigate(PRIVACY_PATH)}>
            {t(lang, 'privacyTitle')}
          </button>
        </div>
      </div>
    </>
  );
}
