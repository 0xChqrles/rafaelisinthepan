import { useEffect, useMemo, useState } from 'react';
import {
  anonName,
  dateForDayNumber,
  decodeResult,
  decodeWordResult,
  defaultAvatar,
  wordShareScore,
  type ShareResult,
  type WordShareResult,
} from '@whippin/shared';
import Avatar from '../components/Avatar';
import RunRuler, { rulerStagger } from '../components/RunRuler';
import LoadingWave from '../components/LoadingWave';
import LoadError from '../components/LoadError';
import ErrorScreen from '../components/ErrorScreen';
import { friendsUrl, postFriendsBody, readProfile, type ProfileRead } from '../api';
import {
  deviceIdentity,
  ensureRequestIdentity,
  identityEpoch,
} from '../identity';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { prefetchTurnstileTokens } from '../turnstile';
import { t } from '../i18n';
import { isLang } from '../langs';
import { navigate } from '../routing';
import { timeoutSignal } from '../timeout';

// The #189 invite link's landing: `/join/<publicId>` records the MUTUAL edge, SAYS SO,
// and then gets out of the way. One link does both jobs — "add me" and "come play".
//
// The link a player SHARES is still `/i/<publicId>`; since 2026-08-20 the backend serves
// that path so the link unfurls in a chat as the sender's own mark and name, then bounces
// here (`shared/invite.ts` holds both paths). Nothing about this screen's job moved with
// it — the preview cannot touch the graph, because the edge needs the clicker's key and
// the clicker's device is the only place it exists.
//
// **ACCEPTING IS A BUTTON, for everyone** (#216 trigger rework, user-decided 2026-08-24,
// superseding the auto-add on page load): account creation happens on primary-button taps
// alone, and a page load is not one — a crawler or a mis-tap must not mint an account and
// write an edge. The landing shows WHO invited (their mark and name, the preview card's
// own face) over ONE primary button; the tap bootstraps the clicker's identity if they
// have none — that is the invite funnel, an account created for a brand-new visitor — and
// records the edge, with the button holding a loading state for both legs.
//
// A non-cap 4xx is a VERDICT, not a failure — the score submission's rule. Opening your
// own link (`self_link`), or one naming an id nobody holds, cannot be fixed by asking
// again, so those continue into the game silently (nothing was added, and there is no
// friend to announce). A transport error or a 5xx raises the app's ERROR SURFACE over the
// landing — what happened, TRY AGAIN — since losing the write quietly would leave both
// players none the wiser, and the write is the one thing this click existed to do.
//
// The cap (409 `friend_limit`) is a verdict too — asking again will not empty a full
// list — but it is the ONE the player could act on, and the same "losing it quietly"
// argument applies. So it neither retries nor vanishes: it says so, and its button plays.
// Neutral about whose list is full, because the cap binds either side of the pair and the
// answer does not say which.
//
// The landing replaces itself in history, so a back tap leaves the game rather than
// re-offering the invite, and PLAY hands the destination to App's own home redirect.
//
// **EXPIRED (#204) is the one refusal that is neither a hiccup nor a cap.** An invite link
// carries the sender's account id, and an email link can DELETE that account: the id then
// names nobody, there is no alias and no redirect, and the honest answer is that this link
// is over. It gets the cap's own surface — a state with a way ONWARD rather than a retry —
// because retrying cannot bring an account back, and continuing silently would tell the
// clicker they added a friend they did not.
//
// **AND THE PROFILE READ ALREADY KNOWS IT.** `GET /profile` answers 410 `account_gone` for
// a deleted account, which is why this landing does not wait for the ADD to find out: it
// would otherwise draw the erased player's assigned face over a primary button whose only
// possible outcome is `unknown_player`. A read that merely FAILED is not a deletion and
// still shows the assigned identity — the fallback this screen has always had.
export type InviteOutcome = 'added' | 'settled' | 'full' | 'failed' | 'expired';

export async function sendInvite(publicId: string): Promise<InviteOutcome> {
  // ACCEPTING AN INVITE IS A DEPLOY BUTTON (#216): the accepter is by definition a
  // brand-new visitor clicking a link, so the tap that accepts mints their identity on
  // this first need — which is what lands the edge before their first game.
  const request = await ensureRequestIdentity();
  if (!request) return 'settled';
  const { identity, epoch } = request;
  const response = await postFriendsBody(friendsUrl(), {
    token: identity.token,
    add: publicId,
  });
  if (identityEpoch() !== epoch) return 'settled';
  // A 2xx landed the edge (a re-click of an already-accepted link included — you ARE
  // friends, which is exactly what the confirmation says).
  if (response.ok) return 'added';
  if (response.status >= 500) return 'failed';
  // A device signed out from elsewhere: the screen that explains it takes over, and the
  // click continues into the game with nothing announced (no edge was added).
  if (response.status === 409) return 'full';
  // The refusal's CODE, not its status: a 404 here is the target account being GONE, where
  // every other 4xx is a link this client got wrong.
  let error: unknown;
  try {
    error = ((await response.clone().json()) as { error?: unknown }).error;
  } catch {
    error = undefined;
  }
  if (error === 'unknown_player') return 'expired';
  await adoptSignedOutVerdict(response, epoch);
  return 'settled';
}

// What the landing (and the confirmation) shows for the INVITER: their public profile
// when it answers, the pseudonym + generated mark otherwise.
interface Inviter {
  name: string;
  avatar: string | null;
}

// The read's own three states, kept APART on purpose: `null` is "not settled yet", which is
// the loading frame, and `'gone'` is a settled answer that has no face in it. Collapsing
// them into one nullable inviter is what drew a deleted account.
export type InviterState = Inviter | 'gone' | null;

// What each answer of `GET /profile` means HERE. Named so the decision can be read — and
// tested — on its own: `gone` ends the landing, `blank` and `failed` both keep the assigned
// identity, and only a stored profile replaces it.
export function inviterFrom(read: ProfileRead, publicId: string): Exclude<InviterState, null> {
  if (read.status === 'gone') return 'gone';
  if (read.status === 'shown') {
    return { name: read.profile.name || anonName(publicId), avatar: read.profile.avatar };
  }
  return { name: anonName(publicId), avatar: null };
}

// A SIGNED share's result (user-decided 2026-09-05): `/join/<publicId>/<token>` is the
// landing a signed share link bounces to, and it shows what was shared — the score and
// the run, or the word count — over the inviter's face, so the reader sees the result
// they were sent AND the person who sent it, then ADD FRIEND. The token is the share
// codec's own; one this build cannot read is simply a plain invite.
export type SharedResult =
  | { mode: 'sentence'; result: ShareResult }
  | { mode: 'word'; result: WordShareResult };

export function sharedResultFrom(token: string | undefined): SharedResult | null {
  if (!token) return null;
  const sentence = decodeResult(token);
  if (sentence) return { mode: 'sentence', result: sentence };
  const word = decodeWordResult(token);
  return word ? { mode: 'word', result: word } : null;
}

// YOUR OWN signed link is the plain share to you (user-decided 2026-09-05: "when you click
// on your own link you should not have the score screen, it should behave like an
// anonymous link"): the landing exists to show a READER who sent a result and let them
// add that person — neither applies to the sender — so the sender's device skips it and
// opens the shared day directly, exactly where a plain `/s/<token>` sends everyone.
export function isOwnLink(publicId: string): boolean {
  return deviceIdentity()?.accountId === publicId;
}

// Where the landing continues: a plain invite hands the destination to App's own home
// redirect; a shared result opens the DAY it was played (the plain share page's own
// click-through), so "come play" means the same round the reader was just shown.
export function landingAfter(shared: SharedResult | null): string {
  if (!shared || !isLang(shared.result.lang)) return '/';
  const date = dateForDayNumber(shared.result.dayNumber);
  return shared.mode === 'word'
    ? `/${shared.result.lang}/word/${date}`
    : `/${shared.result.lang}/${date}`;
}

// The shared result, drawn IN THE RESULT SCREENS' OWN DRESS (`.solved-score`: the pixel
// number over its named unit — lower is better on the sentence, higher on the word, and
// the unit is what tells a stranger which; user feedback 2026-09-05, the first cut set it
// in the chrome face and "the layout seems broken"), the run ruler for a sentence, the
// day's word for the word game, and the calendar date. Settled, replaying nothing: this is
// someone else's finished round. A capped round prints the literal `∞` — this is ordinary
// text in the unit's own face, not the pixel number the result screen draws from path data.
function SharedResultBlock({ shared, lang }: { shared: SharedResult; lang: string }) {
  if (shared.mode === 'sentence') {
    const { score, capped, trajectory, solvedAt, dayNumber } = shared.result;
    const unit = t(lang, !capped && score === 1 ? 'try' : 'tries');
    return (
      <div className="invite-result">
        <span className="solved-score">
          <span className="solved-score-num">{capped ? '∞' : score}</span>
          <span className="solved-score-unit">{unit}</span>
        </span>
        <div className="run-ruler-frame" aria-hidden="true">
          <RunRuler
            trajectory={trajectory}
            solvedAt={capped ? [] : solvedAt}
            stagger={rulerStagger(1)}
            shown
            colorized
          />
        </div>
        <span className="invite-done-line">{dateForDayNumber(dayNumber)}</span>
      </div>
    );
  }
  const { counts, word, dayNumber } = shared.result;
  const score = wordShareScore(counts);
  return (
    <div className="invite-result">
      <span className="invite-result-word">{word.toLocaleUpperCase(shared.result.lang)}</span>
      <span className="solved-score">
        <span className="solved-score-num">{score}</span>
        <span className="solved-score-unit">{t(lang, score === 1 ? 'foundWord' : 'foundWords')}</span>
      </span>
      <span className="invite-done-line">{dateForDayNumber(dayNumber)}</span>
    </div>
  );
}

export default function FriendInvite({
  publicId,
  token,
  lang,
}: {
  publicId: string;
  token?: string;
  lang: string;
}) {
  const [inviter, setInviter] = useState<InviterState>(null);
  const shared = useMemo(() => sharedResultFrom(token), [token]);
  // Replace this landing in history so a back tap leaves the game instead of re-offering
  // the invite; the destination is the shared day's, or App's own home redirect.
  const continueToGame = () => navigate(landingAfter(shared), { replace: true });
  // The sender's own signed link: no landing at all, straight to the day (`isOwnLink`).
  const own = shared !== null && isOwnLink(publicId);
  useEffect(() => {
    if (own) navigate(landingAfter(shared), { replace: true });
  }, [own, shared]);
  // The accept's own lifecycle: idle on the landing, busy while the tap's chain runs,
  // done on the confirmation. `full` is the one refusal with its own screen.
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'full' | 'expired'>('idle');
  const [failed, setFailed] = useState(false);

  // WHO is inviting — read before anything is accepted, so the button is a decision about
  // a person rather than a mystery. Best-effort AND BOUNDED: this landing renders no
  // header and no controls until it resolves, so a read that stalls (a dead connection
  // that never errors) would strand the clicker on a bare LOADING with only a reload as
  // the way out. After a few seconds the assigned fallback IS the answer. It resolves
  // ONCE and holds — never swapped under the button.
  useEffect(() => {
    if (own) return undefined;
    let mounted = true;
    (async () => {
      const read = await readProfile(publicId, timeoutSignal(6_000));
      // GONE ends the landing here: no face, no button, no request. `blank` and `failed`
      // both keep the assigned identity — one is a player who never customized theirs, the
      // other is a read this screen may not turn into a claim about anybody.
      if (mounted) setInviter(inviterFrom(read, publicId));
    })();
    return () => {
      mounted = false;
    };
  }, [publicId, own]);

  // The bootstrap challenge a tokenless accept will spend, in hand before the tap.
  useEffect(() => {
    if (deviceIdentity() === null) prefetchTurnstileTokens(1);
  }, [publicId]);

  if (own) return null;

  const accept = () => {
    if (phase === 'busy') return;
    setPhase('busy');
    setFailed(false);
    void sendInvite(publicId)
      .then((outcome) => {
        if (outcome === 'settled') {
          continueToGame();
          return;
        }
        if (outcome === 'added') {
          setPhase('done');
          return;
        }
        if (outcome === 'full' || outcome === 'expired') {
          setPhase(outcome);
          return;
        }
        setPhase('idle');
        setFailed(true);
      })
      .catch(() => {
        // Offline, blocked, missing config — the edge did not land.
        setPhase('idle');
        setFailed(true);
      });
  };

  // The cap is a state, so its screen carries the player on rather than retrying: asking
  // again cannot empty a full list, and a dead end with no way out is the one thing every
  // failure surface here exists to prevent.
  if (phase === 'full' || phase === 'expired' || inviter === 'gone') {
    return (
      <LoadError
        message={t(lang, phase === 'full' ? 'friendListFull' : 'inviteExpired')}
        lang={lang}
        onRetry={continueToGame}
        actionLabel={t(lang, 'gatePlay')}
      />
    );
  }
  if (!inviter) {
    return (
      <p className="status">
        <LoadingWave text={t(lang, 'loading')} />
      </p>
    );
  }
  return (
    <div className="invite-done">
      <Avatar avatar={inviter.avatar ?? defaultAvatar(publicId)} size={64} />
      <span className="invite-done-name">{inviter.name}</span>
      {shared && <SharedResultBlock shared={shared} lang={lang} />}
      {phase === 'done' ? (
        <>
          <p className="invite-done-line" role="status">
            {t(lang, 'inviteAdded')}
          </p>
          <button type="button" className="mix-btn" onClick={continueToGame}>
            {t(lang, 'gatePlay')}
          </button>
        </>
      ) : (
        <button type="button" className="mix-btn" onClick={accept} disabled={phase === 'busy'}>
          {phase === 'busy' ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'inviteAccept')}
        </button>
      )}

      {failed && (
        <ErrorScreen
          lang={lang}
          title={t(lang, 'failedInvite')}
          note={t(lang, 'failedInviteNote')}
          onClose={() => setFailed(false)}
        />
      )}
    </div>
  );
}
