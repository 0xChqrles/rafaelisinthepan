// SAVING AN ACCOUNT TO AN ADDRESS, AND GETTING ONE BACK (#204, reworked 2026-08-26,
// SPLIT INTO TWO DOORS 2026-08-27).
//
// **ONE ENGINE, TWO DOORS.** The server refuses to branch before the code is verified —
// telling somebody "we know this address" ahead of proof is account enumeration — and that
// discretion became the interface's silence: because the back end may not guess the
// intention, the front end stopped asking for it, and the two opposite acts this screen
// performs wore one costume. Saving the account you hold is ADDITIVE; signing into another
// one may DELETE the account this device is on. They took the same taps, in the same words,
// with the same picture on screen, and diverged only in the last half-second — the erase
// confirmation, arriving at maximum sunk cost, after the mail app and the six digits.
//
// So `intent` is DECLARED BY THE ROUTE (`/account/email` vs `/account/signin`) and dresses
// the flow. It never reaches the server: every request, refusal, allowance and Turnstile
// gate is byte-identical, nothing is detected, nothing is routed, and all six endings stay
// reachable from either door. The rule it runs on:
//
//     the declaration shapes the JOURNEY · the server shapes the DESTINATION
//     · the ending always tells the TRUTH about what actually happened
//
// A player who picks the "wrong" door is never blocked and never lied to — they get an
// ending that names the turn, under the face they now hold.
//
// **THE WORDLESS TELL IS THE FACE** (`components/AccountMark.tsx`). Saving keeps one face
// on screen from the first step: it is the object of the sentence. Returning opens on an
// EMPTY grid — somebody is out there — which the recovered account DEVELOPS into when the
// code lands. Same layout, opposite narrative, no copy. There is deliberately no second
// INK: the app's token set is three colours with settled meanings, and a fourth would buy
// at a glance what the picture already says outright.
//
// **THE ERASE CONFIRMATION IS A CROSSROADS, NOT A WARNING.** A trade drawn from one side
// reads as pure loss, so it shows BOTH accounts — the one being left, struck under the word
// DELETED, and the one being joined, lit beside it. That frees its one sentence to carry
// the part the screen cannot draw: what SURVIVES (the active day's play moves across) and
// what does not (the groups, #271). It is still skipped entirely when there is nothing to lose.
//
// It is a CODE, not a magic link: a link opens in whatever browser the mail client prefers
// rather than the one that asked, and corporate scanners prefetch links and spend
// single-use tokens before the human ever taps.
//
// **CONTINUE IS AN ACCOUNT-DEPLOYING TRIGGER** (#216's sixth), on BOTH doors: an email link
// needs an account to bind, and "this device is empty" is precisely the reconnect case this
// screen exists for. It wears the shape that rule defines — one tap chaining the bootstrap,
// a loading state on the button, a SEND that did not land on the app's error surface.
//
// **EVERY VERDICT ANSWERS IN PLACE; only an act that did not land takes the screen.** The
// error bot is for an ACT that failed: a SEND (a 503 `mail_unavailable`, a dropped
// connection: CODE NOT SENT), or a VERIFY whose answer was lost or cannot be read — read
// again first (`recoverAmbiguous`), then CODE NOT CHECKED from the code step, STILL ON THIS
// ACCOUNT from the crossroads (NO ANSWER there when the read again could not be had either:
// the erase or the switch may have committed). What the server says about what was typed
// stays where it was typed: too many sends is the danger line under CONTINUE (or, from
// RESEND, the code step's held line); a wrong code shakes the keys; a code that accepts
// nothing more — expired, or its attempts spent — keeps the player ON THE CODE STEP, the
// keys gone dead in their own material, the held line saying why and RESEND live. The
// crossroads has no keys, so a verdict on the code pressed there steps back to them and
// answers there.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  AVATAR_PALETTES,
  decodeAvatar,
  defaultAvatar,
  isValidEmail,
  isValidLinkCode,
  LINK_CODE_TTL_SECONDS,
  normalizeEmail,
} from '@whippin/shared';
import {
  isUnknownDeviceAnswer,
  linkUrl,
  parseAccountSummary,
  parseErasePrompt,
  parseBadCode,
  parseLinkResult,
  postLinkBody,
  type AccountStakes,
  type LinkErasePrompt,
  type LinkResult,
} from '../api';
import {
  faceSettled,
  shownFace,
  useAccountFace,
  useOwnFace,
  type Face,
  type FaceState,
} from '../components/AccountFace';
import ArrowIcon from '../assets/icons/arrow-right.svg?react';
import AccountStats from '../components/AccountStats';
import AccountMark from '../components/AccountMark';
import AddressField from '../components/AddressField';
import AddressLine from '../components/AddressLine';
import Avatar from '../components/Avatar';
// The house's Bayer tiles on the root (`--dz-*`): the face holds stipple through them, the
// leaving face thins through them, and the ending's lines come in through them.
import '../components/bayerTiles';
import CodeInput from '../components/CodeInput';
import ErrorScreen from '../components/ErrorScreen';
import FoilStamp from '../components/FoilStamp';
import { foilSeed } from '../components/foil';
import BusyButton from '../components/BusyButton';
import LangTitle from '../components/LangTitle';
import { HeaderBack, HeaderLeft } from '../components/TopBar';
import {
  adoptLinkedAccount,
  currentRequestIdentity,
  ensureRequestIdentity,
  identityEpoch,
  markDeviceSignedOut,
  type RequestIdentity,
  useDeviceIdentity,
} from '../identity';
import useKeyboardInset from '../hooks/useKeyboardInset';
import { prefersReducedMotion } from '../hooks/useScramble';
import useUiLang from '../hooks/useUiLang';
import { t, tn, type UiKey } from '../i18n';
import { ACCOUNT_PATH, type LinkIntent } from '../langs';
import { navigate } from '../routing';
import {
  loadAccountSummary,
  noteAccountEmail,
  resumeDepartureDrain,
  useAccountSummary,
} from '../state/account';
import { recoveredLinkResult } from '../state/linkRecovery';
import { prefetchTurnstileTokens, turnstileToken } from '../turnstile';

type Step = 'address' | 'code' | 'confirm' | 'done';
type LinkOutcome = 'bound' | 'adopted' | 'already_bound';

// THE FACES, at WHOLE-PIXEL sizes (a cell is 6, 5 and 8 CSS pixels): the lead over the two
// input steps, the two sides of the crossroads, and the ending, which is the screen's one
// subject — the lead's own mark, stepped forward.
export const FLOW_FACE_PX = { lead: 60, cross: 50, ending: 80 } as const;
const LEAD_PX = FLOW_FACE_PX.lead;
const CROSS_PX = FLOW_FACE_PX.cross;
const ENDING_PX = FLOW_FACE_PX.ending;
// How long the face takes to step up to the ending's size (`.link-face`'s `link-step-up`):
// the save's stamp lands on the mark at its full size.
const ENDING_STEP_MS = 240;
// A step LEAVES through the dither before the next one arrives (`.link-step.leaving`); the
// ending's face TRAVELS from where the lead stood to its own place in whole steps, while it
// steps up.
const STEP_LEAVE_MS = 120;
const FACE_TRAVEL_STEPS = 4;

// A face's box while its read is out: the slate checker the house waits in (the archive's
// and the podium's ghosts), stippled through the Bayer tiles and breathing in whole steps —
// never a grey rounded block. A settled face with nothing to draw (a DELETED account) keeps
// the box and draws nothing in it — the player's OWN account gone draws its ghost there
// (`gone`); the player's OWN face whose read FAILED rests in it on the still stipple
// (`failed`), never on the assigned stranger.
function FaceHold({
  size,
  waiting,
  failed = false,
  gone = false,
}: {
  size: number;
  waiting: boolean;
  failed?: boolean;
  gone?: boolean;
}) {
  return (
    <span
      className={`link-hold${waiting ? ' waiting' : failed ? ' failed' : gone ? ' ghost-mark' : ''}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

// How long before RESEND is offered. Long enough that a mail has had a chance to arrive —
// tapping it earlier only spends one of the five sends the server allows per hour.
const RESEND_AFTER_SECONDS = 30;

// THE TRIP TO THE MAIL APP MUST NOT COST A CODE (review finding). Every fact about where
// the flow stood was component state, so a RELOAD put the player back on the address step
// with the code in their inbox now unreachable — and the only way forward is to send
// another, out of the five the server allows per address per hour. Android evicts
// backgrounded tabs routinely and switching apps to fetch the code is what this step asks
// for, so the reload is not an edge case: it is the step's own happy path, interrupted.
//
// sessionStorage, because the flow's life IS this tab's: a new tab is a new attempt, and
// none of this is account state worth surviving one. It holds no code and no token — only
// which address was written to and WHEN, which is also what makes the resend countdown
// wall-clock (below) instead of a tick counter the browser suspends in a background tab.
const RESUME_KEY = 'whippin-link-step';

interface Resumable {
  intent: LinkIntent;
  address: string;
  sentAt: number;
}

function readResumable(intent: LinkIntent): Resumable | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw === null) return null;
    const held = JSON.parse(raw) as Partial<Resumable>;
    // The DOOR is part of the identity: a resume onto the other one would dress the wrong
    // narrative around a code sent from this one.
    if (held.intent !== intent) return null;
    if (typeof held.address !== 'string' || !isValidEmail(held.address)) return null;
    if (typeof held.sentAt !== 'number' || !Number.isFinite(held.sentAt)) return null;
    // A code the server has already forgotten resumes nothing — the step would refuse the
    // first thing typed into it. Inside the TTL it is still the code in the player's mail.
    if (Date.now() - held.sentAt > LINK_CODE_TTL_SECONDS * 1_000) return null;
    return { intent, address: held.address, sentAt: held.sentAt };
  } catch {
    return null;
  }
}

function writeResumable(value: Resumable | null): void {
  try {
    if (value === null) sessionStorage.removeItem(RESUME_KEY);
    else sessionStorage.setItem(RESUME_KEY, JSON.stringify(value));
  } catch {
    // A session that cannot remember simply does not resume — never a failed flow.
  }
}

// THE ENDING HAS TO SURVIVE ITS OWN SUCCESS. An ADOPT changes the account this device acts
// as, which bumps the identity SCOPE — and App keys every routed surface on it, so this
// screen is unmounted and remounted in the same tick the link lands. Without this the one
// sentence the whole flow exists to say would be set on a component that no longer exists,
// and the fresh one would open on the address field as though nothing had happened.
//
// Module-level, because the module is exactly what survives a remount, and NAMED by the
// account it is about, so it can never be read by a different one. Consumed ONCE — in an
// effect rather than in a state initializer, since React double-invokes initializers in
// development and clearing there would lose it on the second call. (`intent` needs no
// carrying: it comes from the ROUTE, which the remount preserves.)
let justLinked: {
  accountId: string;
  outcome: LinkOutcome;
  email: string;
  stakes: AccountStakes | null;
} | null = null;

// What a VERIFY puts on the wire: the code for the address, and the CONSENTS it carries.
// **THE RETURNING DOOR AUTHORIZES NO BINDING** (the owner's rule). A player who came
// to RECOVER an account and typed an address nobody holds did not ask to have their local
// one bound to it — that is a different act, and a costly one: an account carries at most
// ONE address, so a mistyped address would SPEND the slot and leave the account unable to be
// saved under the right one. This is not the declared intent crossing the wire (it never
// does); it is the caller naming what it authorizes, exactly as `erase` and `leave` do.
export function verifyBody(
  token: string,
  email: string,
  code: string,
  returning: boolean,
  confirm?: { erase?: string; leave?: string },
): { token: string; email: string; code: string; bind: boolean; erase?: string; leave?: string } {
  return { token, email, code, bind: !returning, ...(confirm ?? {}) };
}

// WHAT A VERIFY'S ANSWER MEANS, read off its CODE, never its status alone (the root
// AGENTS.md's live routes). A 5xx, a transport failure (the caller's), or an answer this
// screen cannot read — a link it cannot parse, a confirmation naming no account, a code it
// does not know — is UNKNOWN, never a verdict: the verify may have landed, so the caller
// reads again before it says anything.
export type VerifyAnswer =
  | { kind: 'linked'; result: LinkResult }
  | { kind: 'signedOut' }
  | { kind: 'confirm'; prompt: LinkErasePrompt }
  | { kind: 'wrong'; attemptsLeft: number; exhausted: boolean }
  // The code accepts nothing more: why, as the code step's held line says it.
  | { kind: 'dead'; line: 'linkCodeExpired' | 'linkCodeSpent' }
  // A fact about the ADDRESS, said at its field.
  | { kind: 'address'; note: 'linkNoAccountThere' | 'linkAlreadySaved' }
  | { kind: 'unknown' };

export function readVerifyAnswer(status: number, body: unknown): VerifyAnswer {
  if (status >= 200 && status < 300) {
    try {
      return { kind: 'linked', result: parseLinkResult(body) };
    } catch {
      return { kind: 'unknown' };
    }
  }
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (isUnknownDeviceAnswer(status, error)) return { kind: 'signedOut' };
  if (status >= 500) return { kind: 'unknown' };
  // THE TWO CONFIRMATIONS, one screen. `would_erase` names an account that is about to
  // become unreachable; `would_switch` an account that survives and is merely being left.
  // The prompt degrades a long way (a missing `target` falls back to one face, missing stakes
  // print no numbers), so one that names no account to ask about is an answer this screen
  // cannot read.
  if (error === 'would_erase' || error === 'would_switch') {
    const prompt = parseErasePrompt(body, error === 'would_erase' ? 'erase' : 'switch');
    return prompt ? { kind: 'confirm', prompt } : { kind: 'unknown' };
  }
  if (error === 'bad_code') return { kind: 'wrong', ...parseBadCode(body) };
  if (error === 'code_expired' || error === 'no_code') return { kind: 'dead', line: 'linkCodeExpired' };
  if (error === 'code_spent') return { kind: 'dead', line: 'linkCodeSpent' };
  // Nobody is at that address, and this door did not authorize creating anybody.
  if (error === 'no_account') return { kind: 'address', note: 'linkNoAccountThere' };
  // SAVE-door only: the returning door never reaches the bind branch, so this is a device
  // that came to save an account which already carries an address of its own.
  if (error === 'account_linked') return { kind: 'address', note: 'linkAlreadySaved' };
  return { kind: 'unknown' };
}

// The flow's acts that did not land, each named by what was lost (the error surface's title)
// — or, where nothing could be read about it, by no claim at all (`unknown`).
type Failure = 'send' | 'check' | 'switch' | 'unknown';
const FAILURE_TITLE = {
  send: 'linkSendFailed',
  check: 'linkCheckFailed',
  switch: 'linkSwitchFailed',
  unknown: 'noAnswer',
} as const satisfies Record<Failure, UiKey>;

// The address the code went to, as the line may WRAP it: a break offered before the '@' and
// after each dot, so a long address reads whole over two lines rather than cut short.
function breakableAddress(address: string): ReactNode {
  const parts: string[] = [];
  let part = '';
  for (const ch of address) {
    if (ch === '@' && part) {
      parts.push(part);
      part = '';
    }
    part += ch;
    if (ch === '.') {
      parts.push(part);
      part = '';
    }
  }
  if (part) parts.push(part);
  return parts.map((piece, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {piece}
    </Fragment>
  ));
}

export default function AccountEmail({ intent }: { intent: LinkIntent }) {
  const lang = useUiLang();
  const identity = useDeviceIdentity();
  const returning = intent === 'return';

  const carried =
    identity !== null && justLinked?.accountId === identity.accountId ? justLinked : null;
  // Read ONCE, and only when there is no ending to show: a completed link outranks a code
  // that was in flight before it.
  const [resumed] = useState(() => (carried ? null : readResumable(intent)));

  // WHAT THIS ACCOUNT IS SAVED AS — the cached summary, not a new request (and a tokenless
  // device gets the answer without one at all, #216). The RETURN door reads it to know what
  // signing in would cost; the SAVE door to know whether there is anything left to save.
  const { phase: summaryPhase, summary } = useAccountSummary();
  const ownSummary = identity !== null && summary?.accountId === identity.accountId ? summary : null;
  const summaryKnown = identity === null || ownSummary !== null || summaryPhase === 'failed';
  useEffect(() => {
    loadAccountSummary();
  }, [identity]);
  // THE SAVE DOOR ON AN ACCOUNT ALREADY SAVED opens on its SAVED ENDING — the errand is
  // done, and an address field would only earn the `account_linked` refusal. Straight onto
  // it when the summary is in hand; while it is out the lead stands with the field and the
  // call HELD (`deciding`), and the answer either lets them in or turns the step into the
  // ending, the lead's face stepping forward as it does on any save.
  const savedAs = !returning ? (ownSummary?.email ?? null) : null;
  const fresh = !returning && !carried && !resumed;
  const [step, setStep] = useState<Step>(
    carried ? 'done' : resumed ? 'code' : fresh && savedAs !== null ? 'done' : 'address',
  );
  const [deciding, setDeciding] = useState(() => fresh && savedAs === null && !summaryKnown);
  // THE STEP LEAVES BEFORE THE NEXT ONE COMES: the code step's lines dissolve out through the
  // dither — the lead (the face, its chip) standing — and only then does the crossroads or the
  // ending take its place. Where the lead stood is noted as it goes, so the ending's face
  // can travel out of it rather than appear somewhere else.
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
  }, []);
  const leadRef = useRef<HTMLDivElement>(null);
  const leadRects = useRef<{ mark: DOMRect; chip: DOMRect | null } | null>(null);
  const advance = useCallback((next: Step) => {
    const lead = leadRef.current;
    const mark = lead?.firstElementChild;
    const chip = mark?.nextElementSibling;
    leadRects.current = mark
      ? {
          mark: mark.getBoundingClientRect(),
          chip: chip?.classList.contains('link-name') && !chip.classList.contains('link-hold') ? chip.getBoundingClientRect() : null,
        }
      : null;
    if (prefersReducedMotion()) {
      setStep(next);
      return;
    }
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      setLeaving(false);
      setStep(next);
    }, STEP_LEAVE_MS);
  }, []);
  const [outcome, setOutcome] = useState<LinkOutcome | null>(
    carried?.outcome ?? (step === 'done' ? 'already_bound' : null),
  );
  const [linked, setLinked] = useState<string | null>(carried?.email ?? (step === 'done' ? savedAs : null));
  // (A saved answer keeps the step HELD while it leaves: the field never mounts at all.)
  const decided = useRef(false);
  useEffect(() => {
    if (!deciding || !summaryKnown || decided.current) return;
    decided.current = true;
    if (savedAs === null) {
      setDeciding(false);
      return;
    }
    setOutcome('already_bound');
    setLinked(savedAs);
    advance('done');
  }, [deciding, summaryKnown, savedAs, advance]);
  const [receipt, setReceipt] = useState<AccountStakes | null>(carried?.stakes ?? null);
  const [address, setAddress] = useState(resumed?.address ?? '');
  // The instant the code was SENT — the countdown's anchor, and the resume's clock.
  const [sentAt, setSentAt] = useState<number | null>(resumed?.sentAt ?? null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<number | null>(null);
  // The code step's HELD LINE, when it says something other than the tries left: too many
  // sends from RESEND, a code that accepts nothing more.
  const [codeLine, setCodeLine] = useState<UiKey | null>(null);
  // The code accepts nothing more (expired, or its attempts spent): the keys are dead and
  // RESEND is the step's one live act, whatever its countdown says.
  const [dead, setDead] = useState(false);
  // The code step was stepped back to from the crossroads: it comes in through the dither,
  // the crossroads' own arrival.
  const [cameBack, setCameBack] = useState(false);
  const [prompt, setPrompt] = useState<LinkErasePrompt | null>(null);
  // The act that did not land, on the error surface. Its one way out goes back to the step
  // that owns the act, where pressing it again re-runs it.
  const [failed, setFailed] = useState<Failure | null>(null);
  // A standing explanation under the address field — something true about this account that
  // the player has to read before typing again, rather than a failure with a retry.
  const [note, setNote] = useState<string | null>(null);
  const [waitLeft, setWaitLeft] = useState(0);
  // The address line's invalid gesture, running.
  const [shakes, setShakes] = useState(0);
  const shakeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Consumed once, so a later visit opens on the offer rather than on a confirmation of
  // something that happened days ago.
  useEffect(() => {
    if (carried) justLinked = null;
  }, [carried]);

  // The challenges are PREFETCHED while the address is being typed (#203's rule): a bot
  // check landing on the tap costs real seconds on a button the player is watching. TWO,
  // because a tokenless device spends one on the bootstrap this tap performs and the next
  // on the send itself. (Not while the step is deciding: a saved account sends nothing.)
  useEffect(() => {
    if (step === 'address' && !deciding) prefetchTurnstileTokens(2);
  }, [step, deciding]);

  // The resend cooldown, read off the SEND'S OWN INSTANT rather than counted down. A tick
  // counter stalls in a backgrounded tab — which is precisely the tab this step asks the
  // player to leave — so it came back still counting time that had already passed. Reading
  // the wall clock also makes a resumed step correct with no extra bookkeeping: whatever
  // the tab was doing, the answer is the same subtraction.
  useEffect(() => {
    if (sentAt === null) return;
    const left = () =>
      Math.max(0, RESEND_AFTER_SECONDS - Math.floor((Date.now() - sentAt) / 1_000));
    setWaitLeft(left());
    if (left() === 0) return;
    const timer = setInterval(() => {
      const n = left();
      setWaitLeft(n);
      if (n === 0) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [sentAt]);

  // The soft keyboard covers the bottom of the code step on iOS, where the layout viewport
  // does not resize; this is what lets the column scroll its own bottom back into reach.
  useKeyboardInset();

  useEffect(() => () => clearTimeout(shakeTimer.current), []);

  // The code accepts nothing more: the keys go dead, the held line says why.
  const kill = useCallback((line: UiKey) => {
    setCode('');
    setWrong(null);
    setDead(true);
    setCodeLine(line);
  }, []);

  const leave = () => {
    writeResumable(null);
    navigate(ACCOUNT_PATH);
  };
  // Back to the address field, from anywhere that reached it: the code that was sent is
  // moot the moment the player is choosing a different address to send to.
  const backToAddress = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    setLeaving(false);
    writeResumable(null);
    setSentAt(null);
    setWaitLeft(0);
    setStep('address');
    setCode('');
    setWrong(null);
    setDead(false);
    setCodeLine(null);
    setCameBack(false);
  };

  // ── SEND ──────────────────────────────────────────────────────────────────────────────
  // `handOff` moves the caret into the code prompt BEFORE the request — the tap is the only
  // moment iOS will open a keyboard, and by the time the send answers it is long over. Only
  // the address step's two entry points ask for it: RESEND does not (the caret is already in
  // the prompt, or the keys are dead and there is no prompt to hand it to).
  const send = useCallback(
    async ({ handOff = false }: { handOff?: boolean } = {}) => {
      const email = normalizeEmail(address);
      if (email === null || busy) return;
      if (handOff) codeField.current?.focus();
      // Whether the caret is allowed to STAY there. Every path that does not reach the code
      // step puts it back in the address field — otherwise a failed send leaves the player
      // typing into a field that is not on screen, which is worse than the keyboard never
      // opening at all.
      let handedOn = false;
      // Where the act was pressed: RESEND's answers speak on the code step's line.
      const resending = step === 'code';
      setBusy(true);
      setFailed(null);
      try {
        // The DEPLOY: this tap is what gives a tokenless device its account, because an
        // email link has to have one to bind — and a reconnect is by definition a device
        // that holds none.
        const epoch = identityEpoch();
        const resolved = await ensureRequestIdentity(epoch);
        if (!resolved) return;
        const challenge = await turnstileToken();
        const response = await postLinkBody(linkUrl(), {
          token: resolved.identity.token,
          email,
          turnstileToken: challenge,
          lang,
        });
        // What stood under CONTINUE was said about the LAST answer (too many sends, a fact
        // about the address): this one replaces it, and a send that lands leaves none.
        setNote(null);
        if (response.ok) {
          // ALWAYS clear, a resend included: the digits already typed were aimed at the
          // code this send just replaced, so leaving them meant the next two keystrokes
          // auto-submitted a poisoned six and spent one of the five wrong-code attempts.
          setCode('');
          setWrong(null);
          setDead(false);
          setCodeLine(null);
          const now = Date.now();
          setSentAt(now);
          writeResumable({ intent, address: email, sentAt: now });
          setStep('code');
          handedOn = true;
          return;
        }
        const error = ((await response.json().catch(() => ({}))) as { error?: unknown }).error;
        if (isUnknownDeviceAnswer(response.status, error)) {
          markDeviceSignedOut(resolved.epoch);
          return;
        }
        // A VERDICT on the sends asked for: said where it was asked — under CONTINUE, or on
        // the code step's held line.
        if (response.status === 429) {
          if (resending) setCodeLine('linkTooMany');
          else setNote(t(lang, 'linkTooMany'));
          return;
        }
        // A verdict on the ADDRESS: the line shakes, the note says why.
        if (error === 'bad_email') {
          setShakes((n) => n + 1);
          setNote(t(lang, 'linkBadAddress'));
          return;
        }
        setFailed('send');
      } catch {
        setNote(null);
        setFailed('send');
      } finally {
        setBusy(false);
        if (handOff && !handedOn) addressField.current?.focus();
      }
    },
    [address, busy, intent, lang, step],
  );

  // ── VERIFY ────────────────────────────────────────────────────────────────────────────
  const finish = useCallback((resolved: RequestIdentity, result: LinkResult) => {
    if (currentRequestIdentity(resolved.epoch) === null) return;
    setOutcome(result.outcome);
    setLinked(result.email);
    setReceipt(result.stakes ?? null);
    advance('done');
    writeResumable(null);
    noteAccountEmail(result.accountId, result.email);
    if (result.accountId !== resolved.identity.accountId) {
      // Recorded BEFORE the adoption, because the adoption is what unmounts this screen:
      // the remounted one reads it and opens on the ending.
      justLinked = {
        accountId: result.accountId,
        outcome: result.outcome,
        email: result.email,
        stakes: result.stakes ?? null,
      };
      adoptLinkedAccount(resolved.epoch, {
        accountId: result.accountId,
        deviceId: result.deviceId,
      });
    }
    // AFTER the adoption, so the drain runs as the account it landed on (#204). The server
    // drained what it could before answering; this finishes the rest without waiting for the
    // player to visit `/account`.
    resumeDepartureDrain(result.departurePending);
  }, [advance]);

  // What the read again answered: the outcome is SETTLED (the link landed, or the device is
  // signed out, or the identity moved), the account was read and NOTHING LANDED, or it could
  // not be read at all — and then nothing is known either way.
  const recoverAmbiguous = useCallback(
    async (resolved: RequestIdentity, email: string): Promise<'settled' | 'notLanded' | 'unread'> => {
      try {
        // A VERIFY can commit and then lose its response. Ask the token what account it NOW
        // acts as before offering a retry whose challenge may already be consumed.
        const response = await postLinkBody(linkUrl(), { token: resolved.identity.token });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          if (isUnknownDeviceAnswer(response.status, body.error)) {
            markDeviceSignedOut(resolved.epoch);
            return 'settled';
          }
          return 'unread';
        }
        if (currentRequestIdentity(resolved.epoch) === null) return 'settled';
        const result = recoveredLinkResult({
          summary: parseAccountSummary(body),
          previousAccountId: resolved.identity.accountId,
          previousEmail:
            summary?.accountId === resolved.identity.accountId ? summary.email : null,
          requestedEmail: email,
          bindingAuthorized: !returning,
        });
        if (!result) return 'notLanded';
        finish(resolved, result);
        return 'settled';
      } catch {
        return 'unread';
      }
    },
    [finish, returning, summary],
  );

  // Takes the code as an ARGUMENT: the sixth keystroke submits, and React state has not
  // flushed by then. `confirm` is present only from the CROSSROADS, after the player has
  // read what the first verify refused to do silently — and it is how a verdict knows where
  // it was pressed.
  const verify = useCallback(
    async (typed: string, confirm?: { erase?: string; leave?: string }) => {
      const email = normalizeEmail(address);
      if (email === null || !isValidLinkCode(typed) || busy) return;
      const crossroads = confirm !== undefined;
      setBusy(true);
      setCodeLine(null);
      let request: RequestIdentity | null = null;
      // THE VERIFY DID NOT LAND, and the read again found nothing it did: an ACT that did
      // not land, on the error surface — never a line telling the player to type the code
      // again, which the same unreadable answer would only refuse again. From the code step
      // the code is cleared, so typing it checks it again; from the crossroads it is KEPT,
      // so its button presses again — and where the read again could not be had either, the
      // crossroads claims nothing about which account the device is on (`unknown`): pressed
      // again, a verify that did land meets its spent code and reads again.
      const didNotLand = (recovery: 'notLanded' | 'unread') => {
        if (crossroads) {
          setFailed(recovery === 'unread' ? 'unknown' : 'switch');
          return;
        }
        setCode('');
        setFailed('check');
      };
      // A verdict on the CODE answers on the code step. The crossroads has no keys to
      // answer on, so it steps back to them first, through the dither.
      const toKeys = () => {
        if (!crossroads) return;
        setCameBack(true);
        advance('code');
      };
      try {
        // NOT `ensureRequestIdentity`: the SEND has already deployed the account, and a
        // verification is not a moment to mint one (#216 — everything else resolves what
        // exists or stands down).
        const epoch = identityEpoch();
        const resolved = currentRequestIdentity(epoch);
        if (!resolved) return;
        request = resolved;
        const response = await postLinkBody(
          linkUrl(),
          verifyBody(resolved.identity.token, email, typed, returning, confirm),
        );
        const answer = readVerifyAnswer(response.status, await response.json().catch(() => null));
        switch (answer.kind) {
          case 'linked':
            finish(resolved, answer.result);
            return;
          case 'signedOut':
            markDeviceSignedOut(resolved.epoch);
            return;
          case 'confirm':
            // Both confirmations are the crossroads, and both are answered by NAMING the
            // account being left rather than by merely agreeing.
            setPrompt(answer.prompt);
            advance('confirm');
            return;
          case 'address':
            // A FACT, not a failure: said AT the address field with the field still there to
            // type in — a modal would be a dead end on a screen whose one remaining move is
            // to try another address.
            backToAddress();
            setNote(t(lang, answer.note));
            return;
          case 'wrong':
            // The refusal stays AT the input: shake, clear, and say how many tries remain.
            // The LAST allowed mismatch answers here too, with none left (#204's attempt
            // ladder): once the row has shaken, the keys go dead and the held line says so.
            // From the crossroads (another send has replaced the code it held) there is no
            // typed row to shake: the keys come back cleared.
            setWrong(answer.attemptsLeft);
            if (crossroads) {
              toKeys();
              if (answer.exhausted) kill('linkCodeSpent');
              else setCode('');
              return;
            }
            shakeTimer.current = setTimeout(() => {
              setCode('');
              if (answer.exhausted) kill('linkCodeSpent');
            }, 420);
            return;
          case 'dead':
            // A committed bind/adoption consumes the challenge. If that answer was lost and
            // the first reconciliation read also failed, the player's explicit retry lands
            // here; ask the unchanged token before calling the completed operation expired.
            if ((await recoverAmbiguous(resolved, email)) === 'settled') return;
            // The code accepts nothing more: the keys dead, the line saying why, RESEND live.
            toKeys();
            kill(answer.line);
            return;
          case 'unknown': {
            const recovery = await recoverAmbiguous(resolved, email);
            if (recovery !== 'settled') didNotLand(recovery);
            return;
          }
        }
      } catch {
        // (Nothing was sent without a request: nothing can have landed.)
        const recovery = request ? await recoverAmbiguous(request, email) : 'notLanded';
        if (recovery !== 'settled') didNotLand(recovery);
      } finally {
        setBusy(false);
      }
    },
    [address, advance, busy, finish, kill, lang, recoverAmbiguous, returning],
  );

  // The SAVE door leads with WHO is being saved — and it is the SAME face whether or not the
  // account is deployed yet (user-decided 2026-08-26: nothing in the area may tell you
  // which). `useOwnFace` answers the account's profile or the identical local-seed pair, the
  // ONE read every surface of the player's own face shares; the crossroads' leaving side and
  // the ending are this device's own account too, so they draw it as well — a read that
  // FAILED rests on the still stipple there, never on the assigned stranger.
  const ownState = useOwnFace();
  const ownFace = shownFace(ownState);
  // The ending draws the account the player now holds — for an ADOPT that is the recovered
  // one (the identity moves to it and the own face reads it), and its face is the claim "we
  // found your account" actually makes.
  const endingId = identity?.accountId ?? null;
  // `shownFace` throughout: a DELETED account (#204's 410) has no face — not even the
  // assigned one, which is still that player's own — so every one of these draws nothing
  // rather than an identity that no longer exists.
  const endingState: FaceState = step === 'done' && endingId !== null ? ownState : null;
  const endingRead = shownFace(endingState);
  // The crossroads draws BOTH sides of the fork: the account about to be left — this
  // device's own — and the one about to be joined. The server names the second only since
  // vol. 2, so a missing `target` degrades to the one-sided prompt rather than failing a
  // refusal the player has to be able to answer.
  const eraseState: FaceState = step === 'confirm' && prompt !== null ? ownState : null;
  const eraseFace = shownFace(eraseState);
  const eraseMark = eraseFace ? (eraseFace.avatar ?? defaultAvatar(eraseFace.publicId)) : null;
  // A face about to be DELETED is a GHOST (`.ghost-mark`): it arrives whole on its own
  // ground, then its ink thins through the dither and its ground gives way to the slate.
  const ghostStyle = (mark: string) =>
    ({ '--ground': AVATAR_PALETTES[decodeAvatar(mark).palette].bg }) as CSSProperties;
  // The account being ADOPTED is the one this device does NOT own — the server named it a
  // moment ago and nothing here vouches for it, which is exactly why it may not be dressed
  // with an assigned identity when the read says it is gone. A missing side degrades to the
  // one-sided prompt, as a missing `target` already does.
  const targetState = useAccountFace(step === 'confirm' ? (prompt?.target ?? null) : null);
  const targetFace = shownFace(targetState);
  // The lead's first face resolved is HELD for the flow's whole life, because the SEND's
  // own deploy swaps the id from the seed to the account mid-flight, and re-reading then
  // races the background profile write for a face that is the same by construction.
  const [lead, setLead] = useState<Face | null>(null);
  useEffect(() => {
    if (ownFace !== null && lead === null) setLead(ownFace);
  }, [ownFace, lead]);
  const savingFace = lead ?? ownFace;
  // The lead's placeholder breathes only while the read is OUT: a gone account settles with
  // nothing, and a shimmer over it promises a face that is not coming.
  const savingPending = lead === null && !faceSettled(ownState);
  // A read that FAILED has no face to lead with: the mark's and the name's boxes rest on the
  // still stipple (`/account`'s masthead's, without its retry — this screen is about the
  // address), never on the assigned stranger.
  const savingFailed = lead === null && ownState === 'failed';

  // AN ENDING PER CELL of the two-doors × three-outcomes grid. Until vol. 2 four of the six
  // borrowed one of the other two's sentences.
  // FIVE endings, not six: the returning door authorizes no binding, so `bound` is
  // reachable from the SAVE door alone and "nothing was there" is a NOTE at the address
  // field now rather than an ending anybody lands on.
  const endingLine =
    outcome === 'adopted'
      ? t(lang, 'linkRestored')
      : outcome === 'already_bound'
        ? t(lang, returning ? 'linkAlreadyAccount' : 'linkAlreadyAddress')
        : t(lang, 'linkSaved');
  // An ADOPT is a reconnect — the player wants their game back, so PLAY hands them to App's
  // home redirect; so does a RETURN that finds it was already on this account, since the
  // errand is over and they came here to get playing. A BIND was a settings errand started
  // on /account, and teleporting a person who was managing their account into the game reads
  // as losing their place: OK returns them to the screen that now shows the address.
  const endingPlays = outcome === 'adopted' || (returning && outcome === 'already_bound');
  // The composition runs when a face ARRIVES: every ending of the returning door (the grid
  // it opened on has to resolve into somebody), and an adopt from either door (the account
  // genuinely changed hands, and that had no moment at all before).
  const composeEnding = returning || outcome === 'adopted';
  // A face that was ALREADY ON SCREEN (a save from this door: the lead is this account's own
  // face) stands in until the ending's read lands — it steps forward rather than giving way to
  // a slate for the length of a round trip.
  const face = endingRead ?? (step === 'done' && !composeEnding ? savingFace : null);
  // THE SAVE LANDS LIKE THE EDITOR'S: the same foil stamp (`FoilStamp`, /profile's SAVE) sweeps
  // the mark once, after it has stepped forward to the ending's size — on the SAVED ending
  // only, the one where this account just got kept. Once per ending: a later re-read of the
  // face must not stamp it again.
  const stampable = step === 'done' && outcome === 'bound' && face !== null && endingId !== null;
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    if (!stampable || stamp > 0) return undefined;
    const timer = setTimeout(() => setStamp(1), ENDING_STEP_MS);
    return () => clearTimeout(timer);
  }, [stampable, stamp]);
  const erasing = prompt?.kind === 'erase';
  // A SWITCH has no stakes to state — nothing is lost — and printing numbers under the face
  // being left would read as its price. An account with nothing on the board has none to
  // state either.
  const stakes = erasing ? prompt?.stakes ?? null : null;
  const showStakes = stakes !== null && (stakes.streak > 0 || stakes.best > 0 || stakes.days > 0);
  // THE RECEIPT: what signing back in just handed back — the evidence for the claim above
  // it, and the same row `/account` prints, so the two cannot disagree. It is the STAKES'
  // own rule about when to draw: an account whose numbers are all zero has no evidence to
  // offer, and "We found your account." over 0 / 0 / 0 argues against itself. That ending
  // shows the ADDRESS instead, which is the other true new fact about it.
  const showReceipt =
    outcome === 'adopted' &&
    receipt !== null &&
    (receipt.streak > 0 || receipt.best > 0 || receipt.days > 0);
  // The ending's copy FOLLOWS the face in: the face is the beat, and a name at full strength
  // beside a half-drawn mark steals it. Each line comes in through the dither a breath behind
  // the last, in reading order, ending on the action — after the COMPOSITION when a face is
  // arriving (`AccountMark`'s resolve), and right behind the face's step forward when it was
  // already on screen (a save: the lead's mark, grown to the ending's size).
  const arriveAt = (ms: number): number => (composeEnding ? ms : Math.round(ms / 4));
  const arrive = (ms: number): { style: CSSProperties } => ({
    style: { '--arrive-delay': `${arriveAt(ms)}ms` } as CSSProperties,
  });

  // THE ENDING'S FACE TRAVELS OUT OF THE LEAD (noted by `advance` as the code step left):
  // from where the lead's mark stood to its own place, in whole steps, while it steps up —
  // and the name chip, when the lead wore this same name, comes with it rather than being
  // drawn in again. Once: a later re-render does not travel again.
  const endingFaceRef = useRef<HTMLDivElement>(null);
  const endingChipRef = useRef<HTMLSpanElement>(null);
  // (Latched on the ending's first render: the note it reads is spent by the travel.)
  const chipHeldRef = useRef<boolean | null>(null);
  if (step !== 'done') chipHeldRef.current = null;
  else if (chipHeldRef.current === null) chipHeldRef.current = !composeEnding && leadRects.current?.chip != null;
  const chipHeld = chipHeldRef.current === true;
  useLayoutEffect(() => {
    if (step !== 'done') return;
    const from = leadRects.current;
    leadRects.current = null;
    const el = endingFaceRef.current;
    if (!from || !el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    const travel = (node: HTMLElement | null, rect: DOMRect | null) => {
      if (!node || !rect) return;
      const at = node.getBoundingClientRect();
      const dx = Math.round(rect.left + rect.width / 2 - (at.left + at.width / 2));
      const dy = Math.round(rect.top - at.top);
      if (dx === 0 && dy === 0) return;
      node.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], {
        duration: ENDING_STEP_MS,
        easing: `steps(${FACE_TRAVEL_STEPS}, end)`,
      });
    };
    travel(el, from.mark);
    if (!composeEnding) travel(endingChipRef.current, from.chip);
  }, [step]);

  // WHAT A SCREEN READER IS TOLD, in ONE region mounted for the flow's whole life. Every
  // step transition here was silent — the account-deletion confirmation included — because
  // `role="status"` was worn by elements that MOUNT WITH THEIR TEXT, and a live region has
  // to exist before its content changes to be announced. So the regions moved off the
  // visible copy (which is read normally when focus lands on it) and into this one, which
  // never unmounts. Priority is what the player most needs: a standing refusal about the
  // address, then the code step's held line, then a refused code, then where the flow now
  // stands.
  const spoken = (() => {
    if (note !== null) return note;
    if (step === 'code' && codeLine !== null) return t(lang, codeLine);
    if (wrong !== null && wrong > 0) {
      return wrong === 1 ? t(lang, 'linkWrongCodeOne') : tn(lang, 'linkWrongCode', wrong);
    }
    if (step === 'code') return `${t(lang, 'linkSentTo')} ${normalizeEmail(address) ?? ''}`;
    if (step === 'confirm') {
      const lead = !returning ? `${t(lang, 'linkEraseFound')} ` : '';
      return `${lead}${t(lang, erasing ? 'linkEraseKeeps' : 'linkSwitchKeeps')}`;
    }
    if (step === 'done') return endingLine;
    return t(lang, returning ? 'linkTitleReturn' : 'linkTitleSave');
  })();

  // AND FOCUS FOLLOWS THE STEP, on the two that are not a field. The address and code steps
  // focus their own input (which is the act); the confirmation and the ending focus their
  // STACK — a container, never a button. A screen arriving with its own action already
  // outlined is the thing `useModalDismiss` exists to prevent, and since #267 a focused
  // button really does wear the app's outline.
  const stack = useRef<HTMLDivElement>(null);
  // THE TWO FIELDS, so a tap can move the caret between them. iOS raises a keyboard only
  // for a `focus()` made inside a user gesture, and the code step is reached across an
  // `await` — so the code field is MOUNTED FROM THE ADDRESS STEP (offstage) and CONTINUE
  // focuses it synchronously, before the request. The keyboard then stays up across the
  // transition instead of dropping and never coming back.
  const codeField = useRef<HTMLInputElement | null>(null);
  const addressField = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (step === 'confirm' || step === 'done') stack.current?.focus();
  }, [step]);

  return (
    <>
      {/* THE SCREEN'S OWN NAME. `HeaderBack` renders the CURRENT screen's — `/account`
          says ACCOUNT, `/profile` says PROFILE — and this passed `accountTitle`, its
          PARENT's, so the returning door was a screen whose whole text was the word
          CONTINUE, under a header naming somewhere else. The declared intention is the one
          thing either door can honestly call itself. */}
      <HeaderLeft>
        <HeaderBack
          label={t(lang, 'ariaBack')}
          // BACK IS A STEP, not an exit, wherever there is a step to take: from the code
          // it returns to the ADDRESS — which is what the quiet CHANGE ADDRESS button used
          // to be, and why that button is gone. Everywhere else it leaves the flow.
          onBack={() => {
            if (step !== 'code') {
              leave();
              return;
            }
            backToAddress();
          }}
        />
        <LangTitle lang={lang} title={t(lang, returning ? 'linkTitleReturn' : 'linkTitleSave')} />
      </HeaderLeft>
      {/* The crossroads and the endings are FINAL steps: no keyboard is up (the stack takes
          the focus), so on a phone their call parks on the bottom edge (`.link-final`). */}
      <div
        className={`account-screen link-step${step === 'confirm' || step === 'done' ? ' link-final' : ''}${
          leaving ? ' leaving' : ''
        }${cameBack && step === 'code' ? ' came-back' : ''}`}
      >
        <p className="sr-only" role="status">
          {spoken}
        </p>
        {/* THE LEAD STAYS UP THROUGH THE CODE (user-decided 2026-08-28). It is rendered
            OUTSIDE the step branches, so it is one element that survives the address → code
            transition rather than a second one mounting in its place: the RETURNING tile
            keeps churning across the step where the player is actually waiting to be found,
            which is where the picture means the most, and the SAVING face keeps the promise
            its own rule makes — the thing being kept is on screen from the first step to
            the last. A square pixel mark at a whole size, its name in the white chip (the
            share card's and the group landing's name). */}
        {(step === 'address' || step === 'code') && (
          <div ref={leadRef} className="link-stack link-lead" aria-hidden="true">
            {returning ? (
              // THE FIELD. Not a skeleton — nothing is loading. It is the question the
              // screen is asking, drawn: somebody is out there, and this is where they
              // will appear.
              <AccountMark avatar={null} size={LEAD_PX} />
            ) : savingFace ? (
              <>
                <Avatar
                  avatar={savingFace.avatar ?? defaultAvatar(savingFace.publicId)}
                  size={LEAD_PX}
                  sharp
                />
                <span className="link-name">{savingFace.name}</span>
              </>
            ) : (
              // AND THE NAME'S BOX IS HELD TOO (2026-09-03). The mark was reserved and the
              // name was not, so the account's own name landed into no space and pushed the
              // field and CONTINUE down as it arrived — the shift the skeleton rule exists to
              // prevent. Only while the read is OUT, or resting where it FAILED: a GONE account
              // has no name coming, and a placeholder held for one would promise what is not
              // on its way.
              <>
                <FaceHold
                  size={LEAD_PX}
                  waiting={savingPending}
                  failed={savingFailed}
                  gone={lead === null && ownState === 'gone'}
                />
                {(savingPending || savingFailed) && (
                  <span className={`link-name link-hold ${savingPending ? 'waiting' : 'failed'}`}>&nbsp;</span>
                )}
              </>
            )}
          </div>
        )}

        {step === 'address' && deciding && (
          // HELD while the save door does not yet know whether the account is saved: the
          // field's floor alone, and the call's box. Nothing here can be pressed, so nothing
          // offers to be; the field mounts (and takes the focus) once there is something to
          // save.
          <>
            <div className="link-field held" aria-hidden="true" />
            <div className="mix-btn link-call held" aria-hidden="true" />
          </>
        )}
        {step === 'address' && !deciding && (
          <>
            <AddressField
              value={address}
              onChange={(next) => {
                setAddress(next);
                if (note !== null) setNote(null);
              }}
              // An Enter on something that cannot be an address gets the game's own answer
              // to a guess that is not a word: the line shakes, and nothing is sent.
              onEnter={() => {
                if (isValidEmail(address)) void send({ handOff: true });
                else setShakes((n) => n + 1);
              }}
              shakeSignal={shakes}
              placeholder={t(lang, 'linkAddressPlaceholder')}
              label={t(lang, 'linkAddressPlaceholder')}
              fieldRef={addressField}
            />
            <BusyButton
              className="mix-btn link-call"
              lang={lang}
              busy={busy}
              disabled={!isValidEmail(address)}
              onClick={() => void send({ handOff: true })}
            >
              {t(lang, 'linkContinue')}
            </BusyButton>
            {note && <p className="account-note caption danger">{note}</p>}
          </>
        )}

        {step === 'code' && (
          // Where it went — the one thing the player cannot see for themselves, and the
          // answer to "did I typo my own address?" The address in the reading ink, the
          // words before it quiet.
          <p className="link-sent">
            <span>{t(lang, 'linkSentTo')}</span>{' '}
            <span className="link-sent-to">{breakableAddress(normalizeEmail(address) ?? '')}</span>
          </p>
        )}
        {/* THE CODE PROMPT IS MOUNTED FROM THE ADDRESS STEP ON, offstage until it is the
            step. It is the only way iOS ever raises a keyboard for it: `focus()` has to
            happen inside the tap, and by the time the send has answered the tap is long
            over. It sits HERE — between the "sent to" line and the tries-left line the code
            step renders around it — so the reading order is unchanged on the step that
            shows it, and it renders nothing at all on the step that does not. */}
        {(step === 'address' || step === 'code') && (
          <CodeInput
            value={code}
            onChange={(next) => {
              setCode(next);
              if (wrong !== null) setWrong(null);
              if (codeLine !== null) setCodeLine(null);
            }}
            onComplete={(typed) => void verify(typed)}
            // Red only while the refused code is still on screen: once the cells clear
            // for the retype, the row returns to rest and the tries-left LINE carries
            // the message — six empty red boxes read as a broken input, not a verdict.
            invalid={wrong !== null && code !== ''}
            // Never disabled while OFFSTAGE: a disabled input cannot hold focus, so the
            // caret CONTINUE just placed there would be thrown straight back out and the
            // keyboard would close — which is the whole thing this is here to prevent.
            disabled={step === 'code' ? busy || leaving : false}
            dead={step === 'code' && dead}
            offstage={step !== 'code'}
            fieldRef={codeField}
            label={t(lang, 'linkCodeLabel')}
          />
        )}

        {step === 'code' && (
          <>
            {/* Only once an attempt has been SPENT: stating the budget up front reads as a
                warning to somebody who has typed nothing wrong. Its line is HELD under the
                keys from the start, so a verdict lands in place and RESEND never moves — the
                tries left, or what the code step has to say instead (a check not had, too
                many sends, a code that accepts nothing more). */}
            <div className="link-wrong">
              {codeLine !== null ? (
                <p className="account-note account-note-center danger">{t(lang, codeLine)}</p>
              ) : (
                wrong !== null &&
                wrong > 0 && (
                  <p className="account-note account-note-center danger">
                    {wrong === 1 ? t(lang, 'linkWrongCodeOne') : tn(lang, 'linkWrongCode', wrong)}
                  </p>
                )
              )}
            </div>
            {/* ONE quiet control under the cells now: the header's BACK is what changes
                the address (user-decided 2026-08-29), so the row that used to hold two
                similar-looking words holds the one that has nowhere else to live. The quiet
                word in a tappable thing's brackets — which it wears only once it CAN be
                pressed: counting, it is a status line, and its brackets arrive with the offer
                when the clock runs out. Once the code is DEAD it is the step's one live act,
                the countdown waived (the code it guards is gone). */}
            <div className="link-quiet">
              <button
                type="button"
                className={`quiet-btn link-resend${!dead && waitLeft > 0 ? ' counting' : ''}`}
                disabled={busy || (!dead && waitLeft > 0)}
                // (Read as one phrase — the word and its seconds — never "RESEND12".)
                aria-label={!dead && waitLeft > 0 ? `${t(lang, 'linkResend')} ${waitLeft}` : undefined}
                onClick={() => void send()}
              >
                {t(lang, 'linkResend')}
                {!dead && waitLeft > 0 && <span className="link-wait">{waitLeft}</span>}
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && prompt !== null && (
          <div className={`link-stack link-confirm${erasing ? ' erase' : ''}`} ref={stack} tabIndex={-1}>
            {/* From the SAVE door this is a genuine surprise — the player asked to KEEP
                something and is being shown a deletion — so one line explains the turn
                before the screen asks anything. From the RETURN door the address step
                already said it, and repeating it here would read as a scolding. */}
            {!returning && (
              <p className="account-note account-note-center">{t(lang, 'linkEraseFound')}</p>
            )}
            {/* THE CROSSROADS. A trade drawn from one side reads as pure loss, so both
                accounts are here: the one being left, THINNED THROUGH THE DITHER (never an
                opacity — the house's dissolve) under DELETED or under its own name, and the
                one being joined, lit and named in the white chip, a pixel arrow between
                them. The server names the second only since vol. 2, so a prompt without it
                falls back to the single face — a confirmation the player has to be able to
                answer must never depend on a decoration. */}
            {prompt.target !== null ? (
              <div className={`link-cross${erasing ? ' erase' : ' switch'}`}>
                <div className="link-cross-side leaving">
                  {eraseMark ? (
                    <span
                      className={`link-cross-face${erasing ? ' ghost-mark' : ''}`}
                      style={erasing ? ghostStyle(eraseMark) : undefined}
                    >
                      <Avatar avatar={eraseMark} size={CROSS_PX} sharp />
                    </span>
                  ) : (
                    <FaceHold
                      size={CROSS_PX}
                      waiting={!faceSettled(eraseState)}
                      failed={eraseState === 'failed'}
                    />
                  )}
                  {/* The LEAVING side says what is happening to it: DELETED when it is
                      about to become unreachable, and its own NAME when it survives — a
                      switch has nothing red about it, and calling that account "deleted"
                      would be a lie the whole screen exists to avoid telling. */}
                  {erasing ? (
                    <span className="link-cross-tag danger">{t(lang, 'linkEraseDeleted')}</span>
                  ) : (
                    <span className="link-cross-was">{eraseFace?.name ?? '\u00a0'}</span>
                  )}
                </div>
                <ArrowIcon className="link-cross-arrow" aria-hidden="true" />
                <div className="link-cross-side joining">
                  {targetFace ? (
                    <span className="link-cross-face">
                      <Avatar
                        avatar={targetFace.avatar ?? defaultAvatar(prompt.target)}
                        size={CROSS_PX}
                        sharp
                      />
                    </span>
                  ) : (
                    <FaceHold size={CROSS_PX} waiting={!faceSettled(targetState)} />
                  )}
                  {targetFace ? (
                    <span className="link-name small">{targetFace.name}</span>
                  ) : (
                    <span className="link-cross-tag">&nbsp;</span>
                  )}
                </div>
              </div>
            ) : eraseFace && eraseMark ? (
              <>
                <span
                  className={`link-cross-face single${erasing ? ' ghost-mark' : ''}`}
                  style={erasing ? ghostStyle(eraseMark) : undefined}
                >
                  <Avatar avatar={eraseMark} size={LEAD_PX} sharp />
                </span>
                <span className="link-name">{eraseFace.name}</span>
              </>
            ) : (
              <FaceHold
                size={LEAD_PX}
                waiting={!faceSettled(eraseState)}
                failed={eraseState === 'failed'}
              />
            )}
            {/* WHAT IS AT STAKE, DIRECTLY UNDER THE FORK — ahead of the sentence, not
                after it (review finding). Centred below "…come with you. The rest is
                lost.", these three numbers read as what the player is GETTING: they sit
                equidistant from both faces and the line immediately above them is about
                what SURVIVES. Read in this order they are the deletion's own price, and
                the sentence that follows is what qualifies them — "the rest" now has an
                antecedent on screen. QUIET: destruction never glows. */}
            {showStakes && <AccountStats lang={lang} stats={stakes} />}
            {/* The one thing the picture cannot say: what happens to the account being
                left. An ERASE names what survives the deletion — both halves are true and
                neither is obvious, and a confirmation that overstates the damage misleads
                exactly as much as one that hides it. A SWITCH says the opposite thing, and
                it is the one that has to be said out loud: nothing is destroyed here, and
                the account stays reachable by its own address. */}
            <p className="account-note account-note-center">
              {t(lang, erasing ? 'linkEraseKeeps' : 'linkSwitchKeeps')}
            </p>
            {/* Destruction never GLOWS, so the erase is the DANGER cap (the secondary tile
                in the danger ink) and the lit primary is never the one that deletes an account. A switch
                destroys nothing, so it is an ordinary primary — dressing it as a danger
                would teach the red to mean "a decision" rather than "a loss". */}
            <div className="link-calls">
              {erasing ? (
                <BusyButton
                  className="btn btn-secondary btn-danger"
                  lang={lang}
                  busy={busy}
                  onClick={() => void verify(code, { erase: prompt.accountId })}
                >
                  {t(lang, 'linkEraseConfirm')}
                </BusyButton>
              ) : (
                <BusyButton
                  className="btn btn-primary"
                  lang={lang}
                  busy={busy}
                  onClick={() => void verify(code, { leave: prompt.accountId })}
                >
                  {t(lang, 'linkSwitchConfirm')}
                </BusyButton>
              )}
              <button type="button" className="link-quiet-btn" disabled={busy} onClick={leave}>
                {t(lang, 'linkCancel')}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="link-stack link-ending" ref={stack} tabIndex={-1}>
            {/* THE FACE STEPS FORWARD to the ending's size in whole-pixel steps (the lead's 6px
                a cell, then 7, then 8), and on a SAVE the foil stamp lands on it — the editor's
                own save moment, one implementation for both. */}
            <div ref={endingFaceRef} className="link-face">
              {face && endingId ? (
                <>
                  <AccountMark
                    avatar={face.avatar ?? defaultAvatar(face.publicId)}
                    size={ENDING_PX}
                    compose={composeEnding}
                  />
                  {outcome === 'bound' && (
                    <FoilStamp
                      play={stamp}
                      avatar={face.avatar ?? defaultAvatar(face.publicId)}
                      seed={foilSeed(`profile:${endingId}`)}
                    />
                  )}
                </>
              ) : (
                <FaceHold
                  size={ENDING_PX}
                  waiting={!faceSettled(endingState)}
                  failed={endingState === 'failed'}
                />
              )}
            </div>
            {face && endingId && (
              <span
                ref={endingChipRef}
                {...arrive(540)}
                className={`link-name${chipHeld ? '' : ' link-arrive'}`}
              >
                {face.name}
              </span>
            )}
            {/* THE ONE NEW FACT about this account, shown rather than described. A recovery
                shows the history that PROVES it is theirs — "we found your account" is a
                claim and these numbers are its evidence, and the first thing a returning
                player wants to check. Every other ending shows the address, which is the
                thing that just changed. The numbers LAND on the reels as their row arrives:
                they are being handed back. */}
            {showReceipt && receipt ? (
              <div {...arrive(620)} className="link-receipt-stats link-arrive">
                <AccountStats lang={lang} stats={receipt} land={arriveAt(620)} />
              </div>
            ) : (
              linked && (
                <p {...arrive(620)} className="link-receipt link-arrive">
                  <AddressLine address={linked} />
                </p>
              )
            )}
            <p {...arrive(700)} className="link-ending-line link-arrive">
              {endingLine}
            </p>
            <button
              type="button"
              {...arrive(780)}
              className="mix-btn link-call link-arrive"
              onClick={() => {
                loadAccountSummary(true);
                if (endingPlays) navigate('/', { replace: true });
                else leave();
              }}
            >
              {t(lang, endingPlays ? 'gatePlay' : 'linkDone')}
            </button>
          </div>
        )}
      </div>

      {failed !== null && (
        <ErrorScreen
          lang={lang}
          title={t(lang, FAILURE_TITLE[failed])}
          note={t(lang, 'linkFailedNote')}
          onClose={() => setFailed(null)}
        />
      )}
    </>
  );
}
