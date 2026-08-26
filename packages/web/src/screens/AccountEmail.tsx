// SAVING AN ACCOUNT TO AN ADDRESS, AND GETTING IT BACK (#204, reworked 2026-08-26).
//
// ONE FLOW, and that is the whole design: the player types their address, then the code.
// They never say whether they are new or returning, because the server only branches AFTER
// the code is verified — which is what makes the second-device problem tractable. So this
// screen has one path with three endings, and the ending's words are chosen by the OUTCOME
// the server reports rather than by anything the screen guessed beforehand.
//
// **ONE PURPOSE PER STEP.** The address step holds an input and a button and nothing else;
// the code step holds six cells and two quiet links. This used to be a section at the bottom
// of the profile editor, reached by scrolling past a painting grid — which is where the whole
// rework started.
//
// It is a CODE, not a magic link: a link opens in whatever browser the mail client prefers
// rather than the one that asked, and corporate scanners prefetch links and spend single-use
// tokens before the human ever taps.
//
// **CONTINUE IS AN ACCOUNT-DEPLOYING TRIGGER** (#216's sixth), and it has to be: an email
// link needs an account to bind, and "this device is empty" is precisely the reconnect case
// this screen exists for. It wears the shape that rule defines — one tap chaining the
// bootstrap, a loading state on the button, failures on the app's error surface.
//
// **THE ERASE CONFIRMATION IS THE ONE INTERRUPTION.** When linking would delete the account
// this device is on, the first verification is refused with what is at stake and this screen
// says so; only the second call carries the name of the account being erased. It is skipped
// when there is nothing to lose.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultAvatar,
  isValidEmail,
  isValidLinkCode,
  normalizeEmail,
} from '@whippin/shared';
import {
  isUnknownDeviceAnswer,
  linkUrl,
  parseErasePrompt,
  parseLinkResult,
  postLinkBody,
  type LinkErasePrompt,
} from '../api';
import { useAccountFace } from '../components/AccountFace';
import Avatar from '../components/Avatar';
import Button from '../components/Button';
import CodeInput from '../components/CodeInput';
import ErrorSheet from '../components/ErrorSheet';
import LoadingWave from '../components/LoadingWave';
import TopBar from '../components/TopBar';
import {
  adoptLinkedAccount,
  currentRequestIdentity,
  ensureRequestIdentity,
  identityEpoch,
  markDeviceSignedOut,
  useDeviceIdentity,
} from '../identity';
import { t, tn } from '../i18n';
import { ACCOUNT_PATH, resolveHomeLang } from '../langs';
import { navigate } from '../routing';
import { loadAccountSummary, noteAccountEmail } from '../state/account';
import { useGameStore } from '../state/gameStore';
import { prefetchTurnstileTokens, turnstileToken } from '../turnstile';
import CloseIcon from '../assets/icons/close.svg?react';
import Logo from '../assets/logo.svg?react';

type Step = 'address' | 'code' | 'confirm' | 'done';
type LinkOutcome = 'bound' | 'adopted' | 'already_bound';

// How long before RESEND is offered. Long enough that a mail has had a chance to arrive —
// tapping it earlier only spends one of the five sends the server allows per hour.
const RESEND_AFTER_SECONDS = 30;

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
// development and clearing there would lose it on the second call.
let justLinked: { accountId: string; outcome: LinkOutcome } | null = null;

export default function AccountEmail() {
  const lastLang = useGameStore((s) => s.lastLang);
  const lang = resolveHomeLang(lastLang, navigator.language);
  const identity = useDeviceIdentity();

  const carried =
    identity !== null && justLinked?.accountId === identity.accountId ? justLinked : null;
  const [step, setStep] = useState<Step>(carried ? 'done' : 'address');
  const [outcome, setOutcome] = useState<LinkOutcome | null>(carried?.outcome ?? null);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<LinkErasePrompt | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [waitLeft, setWaitLeft] = useState(0);
  const shakeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Consumed once, so a later visit opens on the offer rather than on a confirmation of
  // something that happened days ago.
  useEffect(() => {
    if (carried) justLinked = null;
  }, [carried]);

  // The challenges are PREFETCHED while the address is being typed (#203's rule): a bot
  // check landing on the tap costs real seconds on a button the player is watching. TWO,
  // because a tokenless device spends one on the bootstrap this tap performs and the next
  // on the send itself.
  useEffect(() => {
    if (step === 'address') prefetchTurnstileTokens(2);
  }, [step]);

  // The resend cooldown, counted down on the code step alone.
  useEffect(() => {
    if (waitLeft <= 0) return;
    const timer = setTimeout(() => setWaitLeft((n) => n - 1), 1_000);
    return () => clearTimeout(timer);
  }, [waitLeft]);

  useEffect(() => () => clearTimeout(shakeTimer.current), []);

  const fail = useCallback(
    (title: string, note: string, retry?: boolean) => setRefusal({ title, note, retry }),
    [],
  );

  const leave = () => navigate(ACCOUNT_PATH);

  // ── SEND ──────────────────────────────────────────────────────────────────────────────
  const send = useCallback(
    async (resend = false) => {
      const email = normalizeEmail(address);
      if (email === null || busy) return;
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
          if (!resend) setCode('');
          setWrong(null);
          setWaitLeft(RESEND_AFTER_SECONDS);
          setStep('code');
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
      }
    },
    [address, busy, fail, lang],
  );

  // ── VERIFY ────────────────────────────────────────────────────────────────────────────
  // Takes the code as an ARGUMENT: the sixth keystroke submits, and React state has not
  // flushed by then. `erase` is present only on the SECOND call, after the player has read
  // what the first one refused to do silently.
  const verify = useCallback(
    async (typed: string, erase?: string) => {
      const email = normalizeEmail(address);
      if (email === null || !isValidLinkCode(typed) || busy) return;
      setBusy(true);
      setRefusal(null);
      try {
        // NOT `ensureRequestIdentity`: the SEND has already deployed the account, and a
        // verification is not a moment to mint one (#216 — everything else resolves what
        // exists or stands down).
        const epoch = identityEpoch();
        const resolved = currentRequestIdentity(epoch);
        if (!resolved) return;
        const response = await postLinkBody(linkUrl(), {
          token: resolved.identity.token,
          email,
          code: typed,
          ...(erase ? { erase } : {}),
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (response.ok) {
          const result = parseLinkResult(body);
          setOutcome(result.outcome);
          setStep('done');
          noteAccountEmail(result.accountId, result.email);
          if (result.accountId !== resolved.identity.accountId) {
            // Recorded BEFORE the adoption, because the adoption is what unmounts this
            // screen: the remounted one reads it and opens on the ending.
            justLinked = { accountId: result.accountId, outcome: result.outcome };
            adoptLinkedAccount(resolved.epoch, {
              accountId: result.accountId,
              deviceId: result.deviceId,
            });
          }
          return;
        }
        const error = body.error;
        if (isUnknownDeviceAnswer(response.status, error)) {
          markDeviceSignedOut(resolved.epoch);
          return;
        }
        if (error === 'would_erase') {
          const stakes = parseErasePrompt(body);
          if (stakes) {
            setPrompt(stakes);
            setStep('confirm');
            return;
          }
        }
        if (error === 'bad_code') {
          // The refusal stays AT the input: shake, clear, and say how many tries remain.
          const left = typeof body.attemptsLeft === 'number' ? body.attemptsLeft : 0;
          setWrong(left);
          shakeTimer.current = setTimeout(() => setCode(''), 420);
          if (left === 0) fail(t(lang, 'linkFailed'), t(lang, 'linkCodeSpent'));
          return;
        }
        if (error === 'code_expired' || error === 'code_spent' || error === 'no_code') {
          setStep('address');
          setCode('');
          fail(t(lang, 'linkFailed'), t(lang, 'linkCodeExpired'));
          return;
        }
        if (error === 'account_linked') {
          fail(t(lang, 'linkFailed'), t(lang, 'linkAlreadySaved'));
          return;
        }
        fail(t(lang, 'linkFailed'), t(lang, 'linkVerifyFailedNote'), true);
      } catch {
        fail(t(lang, 'linkFailed'), t(lang, 'linkVerifyFailedNote'), true);
      } finally {
        setBusy(false);
      }
    },
    [address, busy, fail, lang],
  );

  // The ending draws the account the player now holds — for an ADOPT that is the recovered
  // one, and its face is the claim "we found your account" actually makes.
  const endingId = identity?.accountId ?? null;
  const face = useAccountFace(step === 'done' ? endingId : null);
  // The erase confirmation draws the account about to be DELETED — the signed-out screen's
  // own move: numbers state the stakes, a face makes them somebody's.
  const eraseFace = useAccountFace(step === 'confirm' ? (prompt?.accountId ?? null) : null);
  // The address step leads with WHO is being saved. A bare input floating on a screen was
  // the "does not use its space" finding (user feedback 2026-08-26); the face is also the
  // honest statement of what the button will do. A device with NO account leads with the
  // app mark instead — the reconnect case, where there is no local face to show and the
  // chooser's own hero is the app's voice.
  const savingFace = useAccountFace(step === 'address' ? (identity?.accountId ?? null) : null);

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
            onClick={leave}
          >
            <CloseIcon className="ui-icon" aria-hidden />
          </button>
        }
      />
      <div className="account-screen link-step">
        {step === 'address' && (
          <>
            <div className="link-stack link-lead" aria-hidden={identity !== null}>
              {identity === null ? (
                <Logo className="chooser-logo link-logo" role="img" aria-label="Whippin AI" />
              ) : savingFace ? (
                <>
                  <Avatar
                    avatar={savingFace.avatar ?? defaultAvatar(identity.accountId)}
                    size={64}
                  />
                  <span className="account-hero-name">{savingFace.name}</span>
                </>
              ) : (
                <span className="account-hero-mark skeleton" />
              )}
            </div>
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
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isValidEmail(address)) void send();
              }}
            />
            <Button variant="primary" disabled={busy || !isValidEmail(address)} onClick={() => void send()}>
              {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'linkContinue')}
            </Button>
          </>
        )}

        {step === 'code' && (
          <>
            {/* Where it went — the one thing the player cannot see for themselves, and the
                answer to "did I typo my own address?" */}
            <p className="account-note account-note-center">
              {`${t(lang, 'linkSentTo')} ${normalizeEmail(address) ?? ''}`}
            </p>
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
              disabled={busy}
              label={t(lang, 'linkCodeLabel')}
            />
            {/* Only once an attempt has been SPENT: stating the budget up front reads as a
                warning to somebody who has typed nothing wrong. */}
            {wrong !== null && wrong > 0 && (
              <p className="account-note account-note-center danger" role="status">
                {tn(lang, 'linkWrongCode', wrong)}
              </p>
            )}
            <div className="link-quiet">
              <button
                type="button"
                className="link-quiet-btn"
                disabled={busy || waitLeft > 0}
                onClick={() => void send(true)}
              >
                {waitLeft > 0 ? `${t(lang, 'linkResend')} (${waitLeft})` : t(lang, 'linkResend')}
              </button>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="link-quiet-btn"
                disabled={busy}
                onClick={() => {
                  setStep('address');
                  setCode('');
                  setWrong(null);
                }}
              >
                {t(lang, 'linkChangeAddress')}
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && prompt !== null && (
          <div className="link-stack">
            {/* NAMES what is about to be destroyed before asking — and SHOWS it: the mark
                and name the player has been wearing, over the numbers they cost. The
                server refuses to erase without being told which account, so this screen
                is the only thing standing between a tap and a month of play. */}
            {eraseFace ? (
              <>
                <Avatar avatar={eraseFace.avatar ?? defaultAvatar(prompt.accountId)} size={64} />
                <span className="account-hero-name">{eraseFace.name}</span>
              </>
            ) : (
              <span className="account-hero-mark skeleton" aria-hidden="true" />
            )}
            <p className="account-note account-note-center" role="status">
              {t(lang, 'linkEraseWarn')}
            </p>
            <p className="link-stakes">
              <span>
                {t(lang, 'linkEraseStreak')}
                <b>{prompt.streak}</b>
              </span>
              <span>
                {t(lang, 'linkEraseDays')}
                <b>{prompt.days}</b>
              </span>
            </p>
            {/* Destruction never GLOWS: the confirming button is the quiet one, and leaving
                is the ordinary way out. */}
            <Button
              variant="secondary"
              className="link-danger"
              disabled={busy}
              onClick={() => void verify(code, prompt.accountId)}
            >
              {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'linkEraseConfirm')}
            </Button>
            <button type="button" className="link-quiet-btn" disabled={busy} onClick={leave}>
              {t(lang, 'linkCancel')}
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="link-stack">
            {face && endingId ? (
              <>
                <Avatar avatar={face.avatar ?? defaultAvatar(endingId)} size={64} />
                <span className="account-hero-name">{face.name}</span>
              </>
            ) : (
              <span className="account-hero-mark skeleton" aria-hidden="true" />
            )}
            <p className="account-note account-note-center" role="status">
              {outcome === 'adopted' ? t(lang, 'linkRestored') : t(lang, 'linkSaved')}
            </p>
            {/* TWO endings, two returns. An ADOPT is a reconnect — the player wants their
                game back, so PLAY hands them to App's home redirect. A BIND was a settings
                errand started on /account, and teleporting a person who was managing their
                account into the game reads as losing their place: OK returns them to the
                screen that now shows the address they just saved. */}
            {outcome === 'adopted' ? (
              <Button
                variant="primary"
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
        <ErrorSheet
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
