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
// the part the screen cannot draw: what SURVIVES (the active day's play moves across, the
// friends graph is merged). It is still skipped entirely when there is nothing to lose.
//
// It is a CODE, not a magic link: a link opens in whatever browser the mail client prefers
// rather than the one that asked, and corporate scanners prefetch links and spend
// single-use tokens before the human ever taps.
//
// **CONTINUE IS AN ACCOUNT-DEPLOYING TRIGGER** (#216's sixth), on BOTH doors: an email link
// needs an account to bind, and "this device is empty" is precisely the reconnect case this
// screen exists for. It wears the shape that rule defines — one tap chaining the bootstrap,
// a loading state on the button, failures on the app's error surface.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
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
  faceSkeletonClass,
  shownFace,
  useAccountFace,
  useOwnFace,
  type Face,
} from '../components/AccountFace';
import AccountStats from '../components/AccountStats';
import AccountMark from '../components/AccountMark';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import CodeInput from '../components/CodeInput';
import ErrorScreen from '../components/ErrorScreen';
import LoadingWave from '../components/LoadingWave';
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
import useUiLang from '../hooks/useUiLang';
import { t, tn } from '../i18n';
import { ACCOUNT_PATH, PRIVACY_PATH, type LinkIntent } from '../langs';
import { navigate } from '../routing';
import {
  loadAccountSummary,
  noteAccountEmail,
  resumeMergeDrain,
  useAccountSummary,
} from '../state/account';
import { recoveredLinkResult } from '../state/linkRecovery';
import { useGameStore } from '../state/gameStore';
import { prefetchTurnstileTokens, turnstileToken } from '../turnstile';

type Step = 'address' | 'code' | 'confirm' | 'done';
type LinkOutcome = 'bound' | 'adopted' | 'already_bound';

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

// What went wrong, in the words the error surface needs. `retry` is present only when asking
// again can help — a refused code cannot be fixed by re-sending the same one.
interface Refusal {
  title: string;
  note: string;
  retry?: boolean;
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

export default function AccountEmail({ intent }: { intent: LinkIntent }) {
  const lang = useUiLang();
  const identity = useDeviceIdentity();
  const returning = intent === 'return';

  const carried =
    identity !== null && justLinked?.accountId === identity.accountId ? justLinked : null;
  // Read ONCE, and only when there is no ending to show: a completed link outranks a code
  // that was in flight before it.
  const [resumed] = useState(() => (carried ? null : readResumable(intent)));
  const [step, setStep] = useState<Step>(carried ? 'done' : resumed ? 'code' : 'address');
  const [outcome, setOutcome] = useState<LinkOutcome | null>(carried?.outcome ?? null);
  const [linked, setLinked] = useState<string | null>(carried?.email ?? null);
  const [receipt, setReceipt] = useState<AccountStakes | null>(carried?.stakes ?? null);
  const [address, setAddress] = useState(resumed?.address ?? '');
  // The instant the code was SENT — the countdown's anchor, and the resume's clock.
  const [sentAt, setSentAt] = useState<number | null>(resumed?.sentAt ?? null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<LinkErasePrompt | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // A standing explanation under the address field — something true about this account that
  // the player has to read before typing again, rather than a failure with a retry.
  const [note, setNote] = useState<string | null>(null);
  const [waitLeft, setWaitLeft] = useState(0);
  const shakeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Consumed once, so a later visit opens on the offer rather than on a confirmation of
  // something that happened days ago.
  useEffect(() => {
    if (carried) justLinked = null;
  }, [carried]);

  // WHAT SIGNING IN WOULD COST, known before a keystroke is spent. One fact decides it and
  // the client already holds it — whether this device's account has an address of its own —
  // so this is the cached summary, not a new request (and a tokenless device gets the
  // answer without one at all, #216).
  const { phase: summaryPhase, summary } = useAccountSummary();
  useEffect(() => {
    if (returning) loadAccountSummary();
  }, [returning, identity]);

  // The challenges are PREFETCHED while the address is being typed (#203's rule): a bot
  // check landing on the tap costs real seconds on a button the player is watching. TWO,
  // because a tokenless device spends one on the bootstrap this tap performs and the next
  // on the send itself.
  useEffect(() => {
    if (step === 'address') prefetchTurnstileTokens(2);
  }, [step]);

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

  const fail = useCallback(
    (title: string, note: string, retry?: boolean) => setRefusal({ title, note, retry }),
    [],
  );

  const leave = () => {
    writeResumable(null);
    navigate(ACCOUNT_PATH);
  };
  // Back to the address field, from anywhere that reached it: the code that was sent is
  // moot the moment the player is choosing a different address to send to.
  const backToAddress = () => {
    writeResumable(null);
    setSentAt(null);
    setWaitLeft(0);
    setStep('address');
    setCode('');
    setWrong(null);
  };

  // ── SEND ──────────────────────────────────────────────────────────────────────────────
  // `handOff` moves the caret into the code prompt BEFORE the request — the tap is the only
  // moment iOS will open a keyboard, and by the time the send answers it is long over. Only
  // the address step's two entry points ask for it: a retry tapped inside the error dialog
  // does not (moving focus out of an open modal is worse than a closed keyboard), and RESEND
  // does not (the caret is already in the prompt).
  const send = useCallback(
    async ({ resend = false, handOff = false }: { resend?: boolean; handOff?: boolean } = {}) => {
      const email = normalizeEmail(address);
      if (email === null || busy) return;
      if (handOff) codeField.current?.focus();
      // Whether the caret is allowed to STAY there. Every path that does not reach the code
      // step puts it back in the address field — otherwise a failed send leaves the player
      // typing into a field that is not on screen, which is worse than the keyboard never
      // opening at all.
      let handedOn = false;
      setBusy(true);
      setRefusal(null);
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
        if (response.ok) {
          // ALWAYS clear, a resend included: the digits already typed were aimed at the
          // code this send just replaced, so leaving them meant the next two keystrokes
          // auto-submitted a poisoned six and spent one of the five wrong-code attempts.
          setCode('');
          setWrong(null);
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
        if (response.status === 429) {
          fail(t(lang, 'linkFailed'), t(lang, 'linkTooMany'));
          return;
        }
        if (error === 'bad_email') {
          fail(t(lang, 'linkFailed'), t(lang, 'linkBadAddress'));
          return;
        }
        fail(t(lang, 'linkFailed'), t(lang, 'linkSendFailedNote'), true);
      } catch {
        fail(t(lang, 'linkFailed'), t(lang, 'linkSendFailedNote'), true);
      } finally {
        setBusy(false);
        if (handOff && !handedOn) addressField.current?.focus();
      }
    },
    [address, busy, fail, intent, lang],
  );

  // ── VERIFY ────────────────────────────────────────────────────────────────────────────
  const finish = useCallback((resolved: RequestIdentity, result: LinkResult) => {
    if (currentRequestIdentity(resolved.epoch) === null) return;
    setOutcome(result.outcome);
    setLinked(result.email);
    setReceipt(result.stakes ?? null);
    setStep('done');
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
    resumeMergeDrain(result.mergePending);
  }, []);

  const recoverAmbiguous = useCallback(
    async (resolved: RequestIdentity, email: string): Promise<boolean> => {
      try {
        // A VERIFY can commit and then lose its response. Ask the token what account it NOW
        // acts as before offering a retry whose challenge may already be consumed.
        const response = await postLinkBody(linkUrl(), { token: resolved.identity.token });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          if (isUnknownDeviceAnswer(response.status, body.error)) {
            markDeviceSignedOut(resolved.epoch);
            return true;
          }
          return false;
        }
        if (currentRequestIdentity(resolved.epoch) === null) return true;
        const result = recoveredLinkResult({
          summary: parseAccountSummary(body),
          previousAccountId: resolved.identity.accountId,
          previousEmail:
            summary?.accountId === resolved.identity.accountId ? summary.email : null,
          requestedEmail: email,
          bindingAuthorized: !returning,
        });
        if (!result) return false;
        finish(resolved, result);
        return true;
      } catch {
        return false;
      }
    },
    [finish, returning, summary],
  );

  // Takes the code as an ARGUMENT: the sixth keystroke submits, and React state has not
  // flushed by then. `erase` is present only on the SECOND call, after the player has read
  // what the first one refused to do silently.
  const verify = useCallback(
    async (typed: string, confirm?: { erase?: string; leave?: string }) => {
      const email = normalizeEmail(address);
      if (email === null || !isValidLinkCode(typed) || busy) return;
      setBusy(true);
      setRefusal(null);
      let request: RequestIdentity | null = null;
      try {
        // NOT `ensureRequestIdentity`: the SEND has already deployed the account, and a
        // verification is not a moment to mint one (#216 — everything else resolves what
        // exists or stands down).
        const epoch = identityEpoch();
        const resolved = currentRequestIdentity(epoch);
        if (!resolved) return;
        request = resolved;
        const response = await postLinkBody(linkUrl(), {
          token: resolved.identity.token,
          email,
          code: typed,
          // **THE RETURNING DOOR AUTHORIZES NO BINDING** (user-decided 2026-08-28). A
          // player who came to RECOVER an account and typed an address nobody holds did not
          // ask to have their local one bound to it — that is a different act, and a costly
          // one: an account carries at most ONE address, so a mistyped address would SPEND
          // the slot and leave the account unable to be saved under the right one. This is
          // not the declared intent crossing the wire (it never does); it is the caller
          // naming what it authorizes, exactly as `erase` and `leave` do.
          bind: !returning,
          ...(confirm ?? {}),
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (response.ok) {
          finish(resolved, parseLinkResult(body));
          return;
        }
        const error = body.error;
        if (isUnknownDeviceAnswer(response.status, error)) {
          markDeviceSignedOut(resolved.epoch);
          return;
        }
        // THE TWO CONFIRMATIONS, one screen. `would_erase` names an account that is about
        // to become unreachable; `would_switch` an account that survives and is merely
        // being left. Both are the crossroads, and both are answered by NAMING the account
        // being left rather than by merely agreeing.
        if (error === 'would_erase' || error === 'would_switch') {
          const stakes = parseErasePrompt(body, error === 'would_erase' ? 'erase' : 'switch');
          if (stakes) {
            setPrompt(stakes);
            setStep('confirm');
            return;
          }
          // The confirmation degrades a long way — a missing `target` falls back to one
          // face, missing stakes simply print no numbers — so reaching here means the body
          // named no account this screen could ask about, and there is nothing to confirm.
          // It closes WITHOUT a retry: the same code re-sent gets the same refusal, and the
          // generic failure's TRY AGAIN spun that loop with no way out of it.
          fail(t(lang, 'linkFailed'), t(lang, 'linkVerifyFailedNote'));
          return;
        }
        if (error === 'bad_code') {
          // The refusal stays AT the input: shake, clear, and say how many tries remain.
          // The LAST allowed mismatch answers here too, with none left (#204's attempt
          // ladder), which is what puts "too many wrong codes" on screen.
          const { attemptsLeft, exhausted } = parseBadCode(body);
          setWrong(attemptsLeft);
          shakeTimer.current = setTimeout(() => setCode(''), 420);
          if (exhausted) fail(t(lang, 'linkFailed'), t(lang, 'linkCodeSpent'));
          return;
        }
        if (error === 'code_expired' || error === 'code_spent' || error === 'no_code') {
          // A committed bind/adoption consumes the challenge. If that answer was lost and
          // the first reconciliation read also failed, the player's explicit retry lands
          // here; ask the unchanged token before calling the completed operation expired.
          if (await recoverAmbiguous(resolved, email)) return;
          backToAddress();
          fail(t(lang, 'linkFailed'), t(lang, 'linkCodeExpired'));
          return;
        }
        // Nobody is at that address, and this door did not authorize creating anybody.
        // The answer is about the ADDRESS, because that is what the player asked about.
        if (error === 'no_account') {
          backToAddress();
          setNote(t(lang, 'linkNoAccountThere'));
          return;
        }
        if (error === 'account_linked') {
          // A FACT, not a failure: it is said AT the address field with the field still
          // there to type in — a modal would be a dead end on a screen whose one remaining
          // move is to try another address.
          //
          // SAVE-door only now: the returning door never reaches the bind branch at all,
          // so this can only be a device that came to save an account which already carries
          // an address of its own.
          backToAddress();
          setNote(t(lang, 'linkAlreadySaved'));
          return;
        }
        if (response.status >= 500 && (await recoverAmbiguous(resolved, email))) return;
        fail(t(lang, 'linkFailed'), t(lang, 'linkVerifyFailedNote'), true);
      } catch {
        if (request && (await recoverAmbiguous(request, email))) return;
        fail(t(lang, 'linkFailed'), t(lang, 'linkVerifyFailedNote'), true);
      } finally {
        setBusy(false);
      }
    },
    [address, busy, fail, finish, lang, recoverAmbiguous, returning],
  );

  // The ending draws the account the player now holds — for an ADOPT that is the recovered
  // one, and its face is the claim "we found your account" actually makes.
  const endingId = identity?.accountId ?? null;
  // `shownFace` throughout: a DELETED account (#204's 410) has no face — not even the
  // assigned one, which is still that player's own — so every one of these draws nothing
  // rather than an identity that no longer exists.
  const endingState = useAccountFace(step === 'done' ? endingId : null);
  const face = shownFace(endingState);
  // The crossroads draws BOTH sides of the fork: the account about to be deleted, and the
  // one about to be joined. The server names the second only since vol. 2, so a missing
  // `target` degrades to the one-sided prompt rather than failing a refusal the player has
  // to be able to answer.
  const eraseState = useAccountFace(step === 'confirm' ? (prompt?.accountId ?? null) : null);
  const eraseFace = shownFace(eraseState);
  // The account being ADOPTED is the one this device does NOT own — the server named it a
  // moment ago and nothing here vouches for it, which is exactly why it may not be dressed
  // with an assigned identity when the read says it is gone. A missing side degrades to the
  // one-sided prompt, as a missing `target` already does.
  const targetState = useAccountFace(step === 'confirm' ? (prompt?.target ?? null) : null);
  const targetFace = shownFace(targetState);
  // The SAVE door leads with WHO is being saved — and it is the SAME face whether or not the
  // account is deployed yet (user-decided 2026-08-26: nothing in the area may tell you
  // which). `useOwnFace` answers the account's profile or the identical local-seed pair; and
  // the first face resolved is HELD for the flow's whole life, because the SEND's own deploy
  // swaps the id from the seed to the account mid-flight, and re-reading then races the
  // background profile write for a face that is the same by construction.
  const ownState = useOwnFace();
  const ownFace = shownFace(ownState);
  const [lead, setLead] = useState<Face | null>(null);
  useEffect(() => {
    if (ownFace !== null && lead === null) setLead(ownFace);
  }, [ownFace, lead]);
  const savingFace = lead ?? ownFace;
  // The lead's placeholder breathes only while the read is OUT: a gone account settles with
  // nothing, and a shimmer over it promises a face that is not coming.
  const savingPending = lead === null && !faceSettled(ownState);

  // What the RETURN door costs, on the ONE case that has a cost: an account with no address
  // of its own is deleted when this device leaves it. Held silent until the summary has
  // settled — #211's rule: an unknown answer is never rendered as a claim — and silent for a
  // tokenless device, which has no account to replace. The reversible case said so here
  // until 2026-08-28; there is no decision pending on this step, so it was noise, and the
  // switch confirmation says it where it is load-bearing.
  const cost =
    returning &&
    identity !== null &&
    summaryPhase === 'ready' &&
    summary !== null &&
    !summary.email
      ? t(lang, 'linkReturnReplaces')
      : null;

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
  // The ending's copy FOLLOWS the face in when the face is arriving: the composition is the
  // beat, and a name at full strength beside a half-drawn mark steals it. Each line a breath
  // behind the last, in reading order, ending on the action. Nothing when the face was
  // already there (a save), where there is no arrival to wait for.
  const arriveClass = composeEnding ? ' link-arrive' : '';
  const arrive = (ms: number): { style?: CSSProperties } =>
    composeEnding ? { style: { '--arrive-delay': `${ms}ms` } as CSSProperties } : {};

  // WHAT A SCREEN READER IS TOLD, in ONE region mounted for the flow's whole life. Every
  // step transition here was silent — the account-deletion confirmation included — because
  // `role="status"` was worn by elements that MOUNT WITH THEIR TEXT, and a live region has
  // to exist before its content changes to be announced. So the regions moved off the
  // visible copy (which is read normally when focus lands on it) and into this one, which
  // never unmounts. Priority is what the player most needs: a standing refusal about the
  // address, then a refused code, then where the flow now stands.
  const spoken = (() => {
    if (note !== null) return note;
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
  // STACK — a container, never a button, since `buttonFocus` blurs those by design and a
  // dismiss control lit on arrival is the thing `useModalDismiss` exists to prevent.
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
      <div className="account-screen link-step">
        <p className="sr-only" role="status">
          {spoken}
        </p>
        {/* THE LEAD STAYS UP THROUGH THE CODE (user-decided 2026-08-28). It is rendered
            OUTSIDE the step branches, so it is one element that survives the address → code
            transition rather than a second one mounting in its place: the RETURNING tile
            keeps churning across the step where the player is actually waiting to be found,
            which is where the picture means the most, and the SAVING face keeps the promise
            its own rule makes — the thing being kept is on screen from the first step to
            the last. */}
        {(step === 'address' || step === 'code') && (
          <div className="link-stack link-lead" aria-hidden="true">
            {returning ? (
              // THE FIELD. Not a skeleton — nothing is loading. It is the question the
              // screen is asking, drawn: somebody is out there, and this is where they
              // will appear.
              <AccountMark avatar={null} size={64} />
            ) : savingFace ? (
              <>
                <Avatar
                  avatar={savingFace.avatar ?? defaultAvatar(savingFace.publicId)}
                  size={64}
                />
                <span className="account-hero-name">{savingFace.name}</span>
              </>
            ) : (
              <span className={`account-hero-mark${savingPending ? ' skeleton' : ''}`} />
            )}
          </div>
        )}

        {step === 'address' && (
          <>
            <input
              className="account-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              // The screen holds ONE input, and typing into it is the whole purpose —
              // the caret is already there, like the code step's.
              autoFocus
              placeholder={t(lang, 'linkAddressPlaceholder')}
              aria-label={t(lang, 'linkAddressPlaceholder')}
              ref={addressField}
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                if (note !== null) setNote(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isValidEmail(address)) void send({ handOff: true });
              }}
            />
            <Button
              variant="primary"
              disabled={busy || !isValidEmail(address)}
              onClick={() => void send({ handOff: true })}
            >
              {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'linkContinue')}
            </Button>
            {/* What the tap costs, BEFORE the mail app and the six digits — the disclosure
                that stops the crossroads being an ambush. */}
            {cost && <p className="account-note caption">{cost}</p>}
            {note && (
              <p className="account-note caption danger">{note}</p>
            )}
            {/* WHAT HAPPENS TO THE ADDRESS (#229), in the quiet row's own dress — here,
                because this is where an address is actually typed, and a notice a player
                has to go looking for on another screen answers the question after they
                have already answered it themselves. It is the step's ONE quiet control,
                exactly as RESEND is the code step's. */}
            <div className="link-quiet">
              <button
                type="button"
                className="link-quiet-btn link-aside"
                onClick={() => navigate(PRIVACY_PATH)}
              >
                {t(lang, 'privacyFromAddress')}
              </button>
            </div>
          </>
        )}

        {step === 'code' && (
          <>
            {/* Where it went — the one thing the player cannot see for themselves, and the
                answer to "did I typo my own address?" */}
            <p className="account-note account-note-center">
              {`${t(lang, 'linkSentTo')} ${normalizeEmail(address) ?? ''}`}
            </p>
          </>
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
            }}
            onComplete={(typed) => void verify(typed)}
            // Red only while the refused code is still on screen: once the cells clear
            // for the retype, the row returns to rest and the tries-left LINE carries
            // the message — six empty red boxes read as a broken input, not a verdict.
            invalid={wrong !== null && code !== ''}
            // Never disabled while OFFSTAGE: a disabled input cannot hold focus, so the
            // caret CONTINUE just placed there would be thrown straight back out and the
            // keyboard would close — which is the whole thing this is here to prevent.
            disabled={step === 'code' ? busy : false}
            offstage={step !== 'code'}
            fieldRef={codeField}
            label={t(lang, 'linkCodeLabel')}
          />
        )}

        {step === 'code' && (
          <>
            {/* Only once an attempt has been SPENT: stating the budget up front reads as a
                warning to somebody who has typed nothing wrong. */}
            {wrong !== null && wrong > 0 && (
              <p className="account-note account-note-center danger">
                {wrong === 1 ? t(lang, 'linkWrongCodeOne') : tn(lang, 'linkWrongCode', wrong)}
              </p>
            )}
            {/* ONE quiet control under the cells now: the header's BACK is what changes
                the address (user-decided 2026-08-29), so the row that used to hold two
                similar-looking words holds the one that has nowhere else to live. */}
            <div className="link-quiet">
              <button
                type="button"
                className="link-quiet-btn"
                disabled={busy || waitLeft > 0}
                onClick={() => void send({ resend: true })}
              >
                {waitLeft > 0 ? `${t(lang, 'linkResend')} (${waitLeft})` : t(lang, 'linkResend')}
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && prompt !== null && (
          <div className="link-stack" ref={stack} tabIndex={-1}>
            {/* From the SAVE door this is a genuine surprise — the player asked to KEEP
                something and is being shown a deletion — so one line explains the turn
                before the screen asks anything. From the RETURN door the address step
                already said it, and repeating it here would read as a scolding. */}
            {!returning && (
              <p className="account-note account-note-center">{t(lang, 'linkEraseFound')}</p>
            )}
            {/* THE CROSSROADS. A trade drawn from one side reads as pure loss, so both
                accounts are here: the one being left, struck under DELETED, and the one
                being joined, lit and named. The server names the second only since vol. 2,
                so a prompt without it falls back to the single face — a confirmation the
                player has to be able to answer must never depend on a decoration. */}
            {prompt.target !== null ? (
              <div className="link-cross">
                <div className="link-cross-side leaving">
                  {eraseFace ? (
                    <Avatar avatar={eraseFace.avatar ?? defaultAvatar(prompt.accountId)} size={44} />
                  ) : (
                    <span
                      className={`link-cross-mark${faceSkeletonClass(eraseState)}`}
                      aria-hidden="true"
                    />
                  )}
                  {/* The LEAVING side says what is happening to it: DELETED when it is
                      about to become unreachable, and its own NAME when it survives — a
                      switch has nothing red about it, and calling that account "deleted"
                      would be a lie the whole screen exists to avoid telling. */}
                  {erasing ? (
                    <span className="link-cross-tag danger">{t(lang, 'linkEraseDeleted')}</span>
                  ) : (
                    <span className="link-cross-name">{eraseFace?.name ?? ''}</span>
                  )}
                </div>
                <span className="link-cross-arrow" aria-hidden="true" />
                <div className="link-cross-side">
                  {targetFace ? (
                    <Avatar avatar={targetFace.avatar ?? defaultAvatar(prompt.target)} size={44} />
                  ) : (
                    <span
                      className={`link-cross-mark${faceSkeletonClass(targetState)}`}
                      aria-hidden="true"
                    />
                  )}
                  <span className="link-cross-name">{targetFace?.name ?? ''}</span>
                </div>
              </div>
            ) : eraseFace ? (
              <>
                <Avatar avatar={eraseFace.avatar ?? defaultAvatar(prompt.accountId)} size={64} />
                <span className="account-hero-name">{eraseFace.name}</span>
              </>
            ) : (
              <span
                className={`account-hero-mark${faceSettled(eraseState) ? '' : ' skeleton'}`}
                aria-hidden="true"
              />
            )}
            {/* WHAT IS AT STAKE, DIRECTLY UNDER THE FORK — ahead of the sentence, not
                after it (review finding). Centred below "…come with you. The rest is
                lost.", these three numbers read as what the player is GETTING: they sit
                equidistant from both faces and the line immediately above them is about
                what SURVIVES. Read in this order they are the deletion's own price, and
                the sentence that follows is what qualifies them — "the rest" now has an
                antecedent on screen. */}
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
            {/* Destruction never GLOWS, so the erase is the QUIET button in the danger ink
                and the lit primary is never the one that deletes an account. A switch
                destroys nothing, so it is an ordinary primary — dressing it as a danger
                would teach the red to mean "a decision" rather than "a loss". */}
            {erasing ? (
              <Button
                variant="secondary"
                className="link-danger"
                disabled={busy}
                onClick={() => void verify(code, { erase: prompt.accountId })}
              >
                {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'linkEraseConfirm')}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void verify(code, { leave: prompt.accountId })}
              >
                {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'linkSwitchConfirm')}
              </Button>
            )}
            <button type="button" className="link-quiet-btn" disabled={busy} onClick={leave}>
              {t(lang, 'linkCancel')}
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="link-stack" ref={stack} tabIndex={-1}>
            {face && endingId ? (
              <>
                <AccountMark
                  avatar={face.avatar ?? defaultAvatar(endingId)}
                  size={64}
                  compose={composeEnding}
                />
                <span
                  {...arrive(540)}
                  className={`account-hero-name${arriveClass}`}
                >
                  {face.name}
                </span>
              </>
            ) : (
              <span
                className={`account-hero-mark${faceSettled(endingState) ? '' : ' skeleton'}`}
                aria-hidden="true"
              />
            )}
            {/* THE ONE NEW FACT about this account, shown rather than described. A recovery
                shows the history that PROVES it is theirs — "we found your account" is a
                claim and these two numbers are its evidence, and the first thing a
                returning player wants to check. Every other ending shows the address, which
                is the thing that just changed. */}
            {showReceipt && receipt ? (
              <div {...arrive(620)} className={`link-receipt-stats${arriveClass}`}>
                <AccountStats lang={lang} stats={receipt} />
              </div>
            ) : (
              linked && (
                <p
                  {...arrive(620)}
                  className={`link-receipt${arriveClass}`}
                >
                  {linked}
                </p>
              )
            )}
            <p
              {...arrive(700)}
              className={`account-note account-note-center${arriveClass}`}
            >
              {endingLine}
            </p>
            {endingPlays ? (
              <Button
                variant="primary"
                {...arrive(780)}
                onClick={() => {
                  loadAccountSummary(true);
                  navigate('/', { replace: true });
                }}
              >
                {t(lang, 'gatePlay')}
              </Button>
            ) : (
              <Button
                variant="primary"
                {...arrive(780)}
                onClick={() => {
                  loadAccountSummary(true);
                  leave();
                }}
              >
                {t(lang, 'linkDone')}
              </Button>
            )}
          </div>
        )}
      </div>

      {refusal && (
        <ErrorScreen
          lang={lang}
          title={refusal.title}
          note={refusal.note}
          onRetry={
            refusal.retry
              ? () => void (step === 'code' && isValidLinkCode(code) ? verify(code) : send())
              : undefined
          }
          onClose={() => setRefusal(null)}
        />
      )}
    </>
  );
}

// Test seam: the ending's cross-remount carry must not leak between tests.
export function resetJustLinked(): void {
  justLinked = null;
}
