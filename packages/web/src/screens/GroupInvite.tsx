import { useEffect, useState } from 'react';
import { anonName, defaultAvatar, type PublicGroup } from '@whippin/shared';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import LoadingWave from '../components/LoadingWave';
import LoadError from '../components/LoadError';
import ErrorScreen from '../components/ErrorScreen';
import { groupsUrl, parseGroups, postGroupsBody, readGroup, type GroupRead } from '../api';
import { deviceIdentity, ensureRequestIdentity, identityEpoch, useDeviceIdentity } from '../identity';
import { pathForBoard } from '../langs';
import { adoptGroups, loadGroups, useGroups } from '../state/groups';
import { useGameStore } from '../state/gameStore';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { prefetchTurnstileTokens } from '../turnstile';
import { t } from '../i18n';
import { navigate } from '../routing';
import { timeoutSignal } from '../timeout';

// The #271 group invite link's landing: `/join/g/<groupId>` records the MEMBERSHIP, SAYS
// SO, and then gets out of the way. One link does both jobs — "join us" and "come play".
//
// The link a member SHARES is `/g/<groupId>`; the backend serves that path so the link
// unfurls in a chat as the group's name and its members' marks, then bounces here
// (`shared/invite.ts` holds both paths). The preview cannot touch the group, because the
// membership needs the clicker's key and the clicker's device is the only place it exists.
//
// **JOINING IS A BUTTON, for everyone** (#216's trigger rule): account creation happens on
// primary-button taps alone, and a page load is not one — a crawler or a mis-tap must not
// mint an account and write a membership. The landing shows the GROUP (its name over its
// members' marks, the preview card's own face) over ONE primary button; the tap
// bootstraps the clicker's identity if they have none — the invite funnel — and records
// the membership, with the button holding a loading state for both legs.
//
// **A MEMBER ALREADY SKIPS THE LANDING** (user-decided 2026-09-07): a device whose account
// is in this group is sent straight to the group's board.
//
// A non-cap 4xx is a VERDICT, not a failure — the score submission's rule — and continues
// into the game silently. A transport error or a 5xx raises the app's ERROR SURFACE over
// the landing, since losing the write quietly would leave everyone none the wiser, and the
// write is the one thing this tap existed to do. The CAPS (409 `group_full` — the group
// holds `GROUP_MEMBERS_MAX` — and 409 `group_limit` — the clicker is in `GROUPS_MAX`
// groups) are verdicts too, but ones the player could act on — and DIFFERENT acts (ask
// the owner for room / leave one of your own), so each is read off its CODE and named
// for what it is, never off the 409 alone (the repo-wide rule: clients act on the code).
// **EXPIRED** (404 `unknown_group`) is neither a hiccup nor a cap: a link
// naming no group is over, and the profile-style read already knows it before anything
// is offered.
export type JoinOutcome = 'joined' | 'settled' | 'full' | 'limit' | 'failed' | 'expired';

// The groups THIS tab joined from a landing. Module-level, because the tap that joins can
// also MINT the identity, and an acquired identity remounts the routed surface — a
// remounted landing would then read "member already" and skip the confirmation it just
// earned. The skip is for a membership that predates the landing, never one it made.
const joinedHere = new Set<string>();

export async function sendJoin(groupId: string): Promise<JoinOutcome> {
  const request = await ensureRequestIdentity();
  if (!request) return 'settled';
  const { identity, epoch } = request;
  const response = await postGroupsBody(groupsUrl(), { token: identity.token, join: groupId });
  if (identityEpoch() !== epoch) return 'settled';
  if (response.ok) {
    joinedHere.add(groupId);
    // The answer is the caller's groups as they now stand — publish them, so the board
    // this landing hands over to opens on the group without a second read.
    try {
      adoptGroups(parseGroups(await response.json()), identity.accountId);
    } catch {
      // A malformed list is the next read's problem; the membership landed.
    }
    return 'joined';
  }
  if (response.status >= 500) return 'failed';
  let error: unknown;
  try {
    error = ((await response.clone().json()) as { error?: unknown }).error;
  } catch {
    error = undefined;
  }
  if (error === 'group_limit') return 'limit';
  if (response.status === 409) return 'full';
  if (error === 'unknown_group') return 'expired';
  await adoptSignedOutVerdict(response, epoch);
  return 'settled';
}

// A pending read, a missing group and a retryable failure are distinct states.
export type GroupState = PublicGroup | 'gone' | 'failed' | null;

export function groupFrom(read: GroupRead): Exclude<GroupState, null> {
  if (read.status === 'shown') return read.group;
  return read.status;
}

// Hand the destination to App's own home redirect, and replace this landing in history so a
// back tap leaves the game instead of re-offering the invite.
const continueToGame = () => navigate('/', { replace: true });

export default function GroupInvite({ groupId, lang }: { groupId: string; lang: string }) {
  const [group, setGroup] = useState<GroupState>(null);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'full' | 'limit' | 'expired'>('idle');
  const [failed, setFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const identity = useDeviceIdentity();
  const { groups } = useGroups();
  const setLastGroup = useGameStore((s) => s.setLastGroup);

  // WHICH group — read before anything is joined, so the button is a decision about a
  // group rather than a mystery. Bounded: a read that stalls would strand the clicker on
  // a bare LOADING with only a reload as the way out. Failed reads can be retried.
  useEffect(() => {
    let mounted = true;
    setGroup(null);
    (async () => {
      const read = await readGroup(groupId, timeoutSignal(6_000));
      if (mounted) setGroup(groupFrom(read));
    })();
    return () => {
      mounted = false;
    };
  }, [groupId, readAttempt]);

  // A member already skips the landing: the device's own groups say so (no request for a
  // tokenless device — its list is known empty).
  useEffect(() => {
    loadGroups();
  }, [identity]);
  const member = (groups?.some((held) => held.id === groupId) ?? false) && !joinedHere.has(groupId);
  useEffect(() => {
    if (!member) return;
    setLastGroup(groupId);
    navigate(pathForBoard(lang), { replace: true });
  }, [member, groupId, lang, setLastGroup]);

  // The bootstrap challenge a tokenless join will spend, in hand before the tap.
  useEffect(() => {
    if (deviceIdentity() === null) prefetchTurnstileTokens(1);
  }, [groupId]);

  const join = () => {
    if (phase === 'busy') return;
    setPhase('busy');
    setFailed(false);
    void sendJoin(groupId)
      .then((outcome) => {
        if (outcome === 'settled') {
          continueToGame();
          return;
        }
        if (outcome === 'joined') {
          setLastGroup(groupId);
          setPhase('done');
          return;
        }
        if (outcome === 'full' || outcome === 'limit' || outcome === 'expired') {
          setPhase(outcome);
          return;
        }
        setPhase('idle');
        setFailed(true);
      })
      .catch(() => {
        setPhase('idle');
        setFailed(true);
      });
  };

  const openBoard = () => navigate(pathForBoard(lang), { replace: true });

  if (group === 'failed') {
    return (
      <LoadError
        message={t(lang, 'failedJoin')}
        lang={lang}
        onRetry={() => setReadAttempt((attempt) => attempt + 1)}
      />
    );
  }
  // A confirmed cap or missing group offers PLAY; a failed read above offers RETRY.
  if (phase === 'full' || phase === 'limit' || phase === 'expired' || group === 'gone') {
    return (
      <LoadError
        message={t(lang, phase === 'full' ? 'groupFull' : phase === 'limit' ? 'groupLimit' : 'inviteExpired')}
        lang={lang}
        onRetry={continueToGame}
        actionLabel={t(lang, 'gatePlay')}
      />
    );
  }
  if (!group) {
    return (
      <p className="status">
        <LoadingWave text={t(lang, 'loading')} />
      </p>
    );
  }
  // The GROUP and what you can do about it: its name over its members' marks, directly
  // over JOIN, and PLAY under it as the way out for a reader who wants the game and not
  // the group (a landing with one door is a wall).
  return (
    <div className="invite-done">
      <span className="invite-done-name">{group.name}</span>
      <ul className="invite-marks" aria-label={t(lang, 'groupMembers')}>
        {group.members.map((row) => (
          <li key={row.publicId} title={row.name || anonName(row.publicId)}>
            <Avatar avatar={row.avatar ?? defaultAvatar(row.publicId)} size={36} />
          </li>
        ))}
      </ul>
      {phase === 'done' ? (
        <>
          <p className="invite-done-line" role="status">
            {t(lang, 'groupJoined')}
          </p>
          <button type="button" className="mix-btn" onClick={openBoard}>
            {t(lang, 'boardTitle')}
          </button>
          <Button variant="secondary" onClick={continueToGame}>
            {t(lang, 'gatePlay')}
          </Button>
        </>
      ) : (
        <>
          <button type="button" className="mix-btn" onClick={join} disabled={phase === 'busy'}>
            {phase === 'busy' ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'groupJoin')}
          </button>
          <Button variant="secondary" onClick={continueToGame}>
            {t(lang, 'gatePlay')}
          </Button>
        </>
      )}

      {failed && (
        <ErrorScreen
          lang={lang}
          title={t(lang, 'failedJoin')}
          note={t(lang, 'failedJoinNote')}
          onClose={() => setFailed(false)}
        />
      )}
    </div>
  );
}
