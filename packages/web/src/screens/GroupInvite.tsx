import { useEffect, useState } from 'react';
import {
  GROUPS_MAX,
  GROUP_MEMBERS_MAX,
  MARK_GLYPH,
  type BoardPlayer,
  type GroupSummary,
  type PublicGroup,
} from '@whippin/shared';
import BusyButton from '../components/BusyButton';
import Button from '../components/Button';
import ErrorScreen from '../components/ErrorScreen';
import GroupOrbit, { orbitPlacesFor, type SeatState } from '../components/GroupOrbit';
import { shownFace, useOwnFace } from '../components/AccountFace';
import { groupsUrl, parseGroups, postGroupsBody, readGroup, type GroupRead } from '../api';
import { deviceIdentity, ensureRequestIdentity, identityEpoch, useDeviceIdentity } from '../identity';
import { pathForBoard } from '../langs';
import { adoptGroups, loadGroups, useGroups } from '../state/groups';
import { useGameStore } from '../state/gameStore';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { prefetchTurnstileTokens } from '../turnstile';
import { t, tn } from '../i18n';
import { navigate } from '../routing';
import { timeoutSignal } from '../timeout';

// The #271 group invite link's landing: `/join/g/<groupId>` records the MEMBERSHIP and then
// gets out of the way. One link does both jobs — "join us" and "come play".
//
// The link a member SHARES is `/g/<groupId>`; the backend serves that path so the link
// unfurls in a chat as the group's CARD — its name in the white chip, its members' marks on a
// dithered orbit, a `+N` tile — then bounces here (`shared/invite.ts` holds both paths). The
// preview cannot touch the group, because the membership needs the clicker's key and the
// clicker's device is the only place it exists.
//
// **THE CARD, BROUGHT IN** (the 2026-10-06 redesign): the landing CONTINUES that card on the
// screen — the frame's corners and the WHIPPIN AI lockup (the full-screen moments' furniture,
// the signed-out screen's), and in the middle the card's own scene (`GroupOrbit`): the name in
// the chip, up to five marks on the slate orbit, the rest in the `+N` tile, and a SEAT kept
// for the reader. JOIN is the app's big action on the bottom edge, PLAY the word under it.
// Joining DROPS the reader's own mark into the seat; the call turns to the BOARD in place.
// Nothing that has landed moves: the places are decided once, with the seat in them.
//
// **JOINING IS A BUTTON, for everyone** (#216's trigger rule): account creation happens on
// primary-button taps alone, and a page load is not one — a crawler or a mis-tap must not
// mint an account and write a membership. The tap bootstraps the clicker's identity if they
// have none — the invite funnel — and records the membership, the button busy (`BusyButton`)
// for both legs and the seat breathing until the mark arrives.
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
// **A CAP THE LANDING ALREADY KNOWS IS NEVER OFFERED** (`landingOf`): a group whose public
// face holds `GROUP_MEMBERS_MAX` members, or a reader whose own list holds `GROUPS_MAX`
// groups, lands on that verdict with no JOIN — a control that can only be refused is a false
// offer; the server's code still answers the race. Either way the group's face STAYS, one
// quiet line takes JOIN's place and PLAY is the call: nothing here is an alarm.
// **EXPIRED** (404 `unknown_group`) is neither a hiccup nor a cap: a link naming no group is
// over — the board's sad ghost, one line, PLAY. A READ that fails is no verdict about the
// group: its shapes stand still, one line says it could not be shown, and RETRY reads again.
type JoinOutcome = 'joined' | 'settled' | 'full' | 'limit' | 'failed' | 'expired';

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
  if (error === 'group_full') return 'full';
  if (error === 'unknown_group') return 'expired';
  await adoptSignedOutVerdict(response, epoch);
  return 'settled';
}

// A pending read, a missing group and a retryable failure are distinct states.
type GroupState = PublicGroup | 'gone' | 'failed' | null;

export function groupFrom(read: GroupRead): Exclude<GroupState, null> {
  if (read.status === 'shown') return read.group;
  return read.status;
}

// What the landing OFFERS, off what it already knows: JOIN, or a cap the server could only
// answer with a refusal — the group's room (its public face, which drops a gone account and
// so never counts more members than the server does) and the reader's own `GROUPS_MAX` (their
// list, when it has been read).
export type Landing = 'open' | 'full' | 'limit';
export function landingOf(group: PublicGroup, held: readonly GroupSummary[] | null): Landing {
  if (group.members.length >= GROUP_MEMBERS_MAX) return 'full';
  if (held !== null && held.length >= GROUPS_MAX) return 'limit';
  return 'open';
}

// Hand the destination to App's own home redirect, and replace this landing in history so a
// back tap leaves the game instead of re-offering the invite.
const continueToGame = () => navigate('/', { replace: true });

type Phase = 'idle' | 'busy' | 'done' | 'full' | 'limit' | 'expired';

// How long the face waits for the reader's own list once the group has landed.
const LIST_WAIT_MS = 2_000;

export default function GroupInvite({ groupId, lang }: { groupId: string; lang: string }) {
  const [group, setGroup] = useState<GroupState>(null);
  // A landing remounted after its own join (an identity swap) stands joined, its seat taken.
  const [phase, setPhase] = useState<Phase>(() => (joinedHere.has(groupId) ? 'done' : 'idle'));
  const [dropped, setDropped] = useState(false);
  const [failed, setFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const identity = useDeviceIdentity();
  const { phase: listPhase, groups } = useGroups();
  const setLastGroup = useGameStore((s) => s.setLastGroup);
  const ownState = useOwnFace();

  // WHICH group — read before anything is joined, so the button is a decision about a
  // group rather than a mystery. Bounded: a read that stalls would strand the clicker on
  // the holds with only a reload as the way out. Failed reads can be retried.
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

  // THE FACE, decided ONCE, when the group and the reader's own list are both known: who
  // stands on the orbit (never the reader — their place is the seat) and what is offered. The
  // list is waited for a bounded beat past the group: a read that stalls must not hold the
  // landing, so the face lands without it and the server's code answers the cap instead.
  const [listLate, setListLate] = useState(false);
  const groupShown = typeof group === 'object' && group !== null;
  useEffect(() => {
    if (!groupShown) return undefined;
    const timer = window.setTimeout(() => setListLate(true), LIST_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [groupShown]);
  const listKnown = listPhase === 'ready' || listPhase === 'failed' || listLate;
  const [face, setFace] = useState<{ members: BoardPlayer[]; landing: Landing } | null>(null);
  if (face === null && typeof group === 'object' && group !== null && listKnown && !member) {
    const me = identity?.accountId;
    setFace({
      members: group.members.filter((row) => row.publicId !== me),
      landing: phase === 'done' ? 'open' : landingOf(group, listPhase === 'ready' ? groups : null),
    });
  }

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
          setDropped(true);
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

  const own = shownFace(ownState);
  const expired = group === 'gone' || phase === 'expired';
  // A cap the landing knew stands from the start; one the server answered replaces JOIN.
  const shown: Phase = phase === 'idle' && face !== null && face.landing !== 'open' ? face.landing : phase;
  const seated = face !== null && face.landing === 'open';
  const seat: SeatState =
    shown === 'busy' || (shown === 'done' && own === null) ? 'filling' : shown === 'done' ? 'taken' : 'empty';

  // The calls stand in THREE fixed slots — a line, the call, the word under it — so the call
  // is in one place whatever the state, and nothing above it moves when the state changes.
  const play = (
    <button type="button" className="mix-btn" onClick={continueToGame}>
      {t(lang, 'gatePlay')}
    </button>
  );
  let scene;
  let line: string | null = null;
  let call: JSX.Element | null = null;
  let word: JSX.Element | null = null;
  if (expired) {
    scene = (
      <div className="invite-scene invite-gone">
        <span className="board-ghost invite-ghost" aria-hidden="true" />
        <p className="invite-line" role="status">
          {t(lang, 'inviteExpired')}
        </p>
      </div>
    );
    call = play;
  } else if (group === 'failed') {
    scene = <GroupOrbit lang={lang} mode="failed" />;
    line = t(lang, 'inviteFailed');
    call = (
      <button type="button" className="quiet-btn" onClick={() => setReadAttempt((attempt) => attempt + 1)}>
        {t(lang, 'retry')}
      </button>
    );
  } else if (face === null) {
    scene = <GroupOrbit lang={lang} mode="wait" />;
  } else {
    scene = (
      <GroupOrbit
        lang={lang}
        mode="shown"
        name={typeof group === 'object' && group !== null ? group.name : ''}
        places={orbitPlacesFor(face.members, seated)}
        seat={seat}
        own={own}
        drop={dropped}
      />
    );
    if (shown === 'full' || shown === 'limit') {
      // The cap's fact where the call stood over it, and PLAY the call.
      line = shown === 'full' ? t(lang, 'groupFull') : tn(lang, 'inviteLimit', GROUPS_MAX);
      call = play;
    } else {
      // JOIN and the BOARD it turns into are ONE call in one place; PLAY is the way out for
      // a reader who wants the game and not the group (a landing with one door is a wall).
      call =
        shown === 'done' ? (
          <button type="button" className="mix-btn" onClick={openBoard}>
            {t(lang, 'boardTitle')}
          </button>
        ) : (
          <BusyButton className="mix-btn" lang={lang} busy={shown === 'busy'} onClick={join}>
            {t(lang, 'groupJoin')}
          </BusyButton>
        );
      word = (
        <Button variant="secondary" onClick={continueToGame}>
          {t(lang, 'gatePlay')}
        </Button>
      );
    }
  }

  return (
    <div className="invite-landing">
      {/* A FULL-SCREEN MOMENT WITH NO HEADER wears the frame — the corners and the WHIPPIN AI
          lockup — as the card it continues does. (On desktop the device frame's own corners
          stand.) */}
      <div className="invite-frame" aria-hidden="true">
        <div className="streak-lockup">
          <svg viewBox={`0 0 ${MARK_GLYPH.width} ${MARK_GLYPH.height}`} shapeRendering="crispEdges">
            <path d={MARK_GLYPH.path} fill="currentColor" />
          </svg>
          <span>WHIPPIN AI</span>
        </div>
        {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
          <span key={corner} className={`streak-corner ${corner}`} />
        ))}
      </div>
      {scene}
      <div className={`invite-calls${call ? ' in' : ''}`}>
        <p className="invite-line" role="status">
          {line}
        </p>
        {call ?? <span className="invite-slot" />}
        {word ?? <span className="invite-slot" />}
      </div>

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
