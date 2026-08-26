// Saving an account to an email address, and getting it back (#204).
//
// ONE FLOW, and that is the whole design: the player types their address, then the code.
// They never say whether they are new or returning, because the server only branches AFTER
// the code is verified — which is what makes the second-device problem tractable. So this
// component has one path with three endings, and the copy is chosen by the OUTCOME the
// server reports rather than by anything the screen guessed beforehand.
//
// It is a CODE, not a magic link: a link opens in whatever browser the mail client prefers
// rather than the one that asked, and corporate scanners prefetch links and spend
// single-use tokens before the human ever taps. Six digits is also what a French bank asks
// for constantly, so it needs no explaining.
//
// **ITS PRIMARY BUTTON IS AN ACCOUNT-DEPLOYING TRIGGER**, the sixth (#216's five plus this
// one), and of exactly the shape that rule defines: a single tap that chains its real
// action behind the bootstrap, shows a loading state on the button, and reports failure on
// the app's error surface. It HAS to be one — a device with no account cannot be given one
// by an email link, and "this device is empty" is precisely the reconnect case the flow
// exists for.
//
// **THE ERASE CONFIRMATION IS THE ONE INTERRUPTION.** When linking would delete the account
// this device is on, the first verification is refused with what is at stake and the screen
// says so; only the second call carries the name of the account being erased. It is skipped
// when there is nothing to lose — a fresh device that links immediately loses nothing, so
// no dialog.

import { useCallback, useEffect, useState } from 'react';
import { isValidEmail, isValidLinkCode, LINK_CODE_LENGTH, normalizeEmail } from '@whippin/shared';
import {
  isUnknownDeviceAnswer,
  linkUrl,
  parseErasePrompt,
  parseLinkResult,
  postLinkBody,
  type LinkErasePrompt,
} from '../api';
import {
  adoptLinkedAccount,
  currentRequestIdentity,
  ensureRequestIdentity,
  identityEpoch,
  identityEpochOf,
  markDeviceSignedOut,
  useDeviceIdentity,
} from '../identity';
import { adoptSignedOutVerdict } from '../state/signedOutVerdict';
import { prefetchTurnstileTokens, turnstileToken } from '../turnstile';
import { t } from '../i18n';
import Button from './Button';
import ErrorSheet from './ErrorSheet';

type Phase = 'address' | 'code' | 'confirm' | 'done';
type LinkOutcome = 'bound' | 'adopted' | 'already_bound';

// THE ENDING HAS TO SURVIVE ITS OWN SUCCESS. An ADOPT changes the account this device acts
// as, which bumps the identity SCOPE — and App keys every routed surface on it, so this
// component is unmounted and remounted in the same tick the link lands. Without this the one
// sentence the whole flow exists to say ("we found your account") would be set on a component
// that no longer exists, and the fresh one would open on the address field as though nothing
// had happened.
//
// Module-level, because the module is exactly what survives a remount, and NAMED by the
// account it is about, so it can never be read by a different one. Consumed ONCE — in an
// effect rather than in the state initializer, since React double-invokes initializers in
// development and clearing there would lose it on the second call.
let justLinked: { accountId: string; outcome: LinkOutcome } | null = null;

// How hard the client chases a friend merge the server has not finished. Bounded and
// backed off: the identity change has already committed, so this is housekeeping the player
// is not waiting on — and the job is durable, so the next visit picks it up either way.
const MERGE_DRAIN_ATTEMPTS = 4;
const MERGE_DRAIN_DELAY_MS = 1_500;

// What went wrong, in the words the error surface needs. `retry` is present only when
// asking again can help — a refused code cannot be fixed by re-sending the same one.
interface Refusal {
  title: string;
  note: string;
  retry?: boolean;
}

export default function AccountLink({ lang }: { lang: string }) {
  // What this account is SAVED AS. Read once, and only when an account EXISTS: a tokenless
  // device knows its server state is empty and must not call a private route merely to
  // learn that (#216). A read that fails simply leaves the offer standing — the flow itself
  // is what answers the question authoritatively.
  const [bound, setBound] = useState<string | null>(null);
  // A link that landed a beat ago, through the remount it caused (see `justLinked`).
  const landed = useDeviceIdentity();
  const carried = landed !== null && justLinked?.accountId === landed.accountId ? justLinked : null;
  const [phase, setPhase] = useState<Phase>(carried ? 'done' : 'address');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<LinkErasePrompt | null>(null);
  const [outcome, setOutcome] = useState<LinkOutcome | null>(carried?.outcome ?? null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const identity = landed;

  // Consumed once, so a later visit to this screen opens on the offer rather than on a
  // confirmation of something that happened days ago.
  useEffect(() => {
    if (carried) justLinked = null;
  }, [carried]);

  // The READ — and, because it is the same message, the DRAIN: a friend merge an
  // interrupted link left queued is finished by the account's own next call here. It runs
  // on mount and again whenever an account arrives (the SEND's own deploy is one such
  // arrival), and it RETRIES while the server still reports work outstanding, bounded:
  // those edges are consented relationships, so the job may not simply be abandoned.
  useEffect(() => {
    if (!identity) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (attempt: number) => {
      const resolved = currentRequestIdentity(identityEpochOf(identity));
      if (!resolved) return;
      let pending = false;
      try {
        const response = await postLinkBody(linkUrl(), { token: resolved.identity.token });
        if (!response.ok) {
          await adoptSignedOutVerdict(response, resolved.epoch);
          return;
        }
        const body = (await response.json()) as { email?: unknown; mergePending?: unknown };
        if (!live) return;
        setBound(typeof body.email === 'string' ? body.email : null);
        pending = body.mergePending === true;
      } catch {
        // A read that could not be had says nothing about the account: the offer stands.
        return;
      }
      if (!pending || attempt >= MERGE_DRAIN_ATTEMPTS) return;
      timer = setTimeout(() => void ask(attempt + 1), MERGE_DRAIN_DELAY_MS * 2 ** attempt);
    };
    void ask(0);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [identity]);

  // The challenge is PREFETCHED while the address is being typed, the #203 rule: a bot check
  // landing on the tap costs real seconds on a button the player is watching. TWO, because a
  // tokenless device spends one on the bootstrap this tap performs and the next on the send
  // itself — the same pair a first PLAY spends.
  useEffect(() => {
    if (phase === 'address') prefetchTurnstileTokens(2);
  }, [phase]);

  const fail = useCallback(
    (title: string, note: string, retry?: boolean) => setRefusal({ title, note, retry }),
    [],
  );

  // ── SEND ────────────────────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const email = normalizeEmail(address);
    if (email === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      // The DEPLOY: this tap is what gives a tokenless device its account, because an email
      // link has to have an account to bind — and a reconnect is by definition a device
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
        setAttemptsLeft(null);
        setCode('');
        setPhase('code');
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
  }, [address, fail, lang]);

  // ── VERIFY ──────────────────────────────────────────────────────────────────────────
  // `erase` is present only on the SECOND call, after the player has read what the first
  // one refused to do silently.
  const verify = useCallback(
    async (erase?: string) => {
      const email = normalizeEmail(address);
      if (email === null || !isValidLinkCode(code)) return;
      setBusy(true);
      setRefusal(null);
      try {
        // NOT `ensureRequestIdentity`: by now the SEND has deployed the account, and a
        // verification is not a moment to mint one (#216 — the engines resolve what exists
        // or stand down).
        const epoch = identityEpoch();
        const resolved = currentRequestIdentity(epoch);
        if (!resolved) return;
        const response = await postLinkBody(linkUrl(), {
          token: resolved.identity.token,
          email,
          code,
          ...(erase ? { erase } : {}),
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (response.ok) {
          const result = parseLinkResult(body);
          // The device now acts as the account the address reaches. Adopting it clears
          // every account-scoped cache through the identity scope, which is exactly right:
          // none of it belongs to the account just adopted.
          setOutcome(result.outcome);
          setBound(result.email);
          setPhase('done');
          if (result.accountId !== resolved.identity.accountId) {
            // Recorded BEFORE the adoption, because the adoption is what unmounts this
            // component: the remounted one reads it and opens on the ending.
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
            setPhase('confirm');
            return;
          }
        }
        if (error === 'bad_code') {
          const left = typeof body.attemptsLeft === 'number' ? body.attemptsLeft : null;
          setAttemptsLeft(left);
          if (left === 0) fail(t(lang, 'linkFailed'), t(lang, 'linkCodeSpent'));
          return;
        }
        if (error === 'code_expired' || error === 'code_spent' || error === 'no_code') {
          setPhase('address');
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
    [address, code, fail, lang],
  );

  return (
    <section className="account-link">
      <h2 className="account-link-title">{t(lang, 'linkTitle')}</h2>

      {phase === 'address' && (
        <>
          {/* What the account is saved as TODAY, when it is saved at all. A player who has
              already linked needs to see the address, not an offer to link again. */}
          <p className="account-link-note">
            {bound ? `${t(lang, 'linkSavedAs')} ${bound}` : t(lang, 'linkWhy')}
          </p>
          <input
            className="account-link-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            placeholder={t(lang, 'linkAddressPlaceholder')}
            aria-label={t(lang, 'linkAddressPlaceholder')}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <Button
            variant="primary"
            disabled={busy || !isValidEmail(address)}
            onClick={() => void send()}
          >
            {busy ? t(lang, 'loading') : t(lang, 'linkSend')}
          </Button>
        </>
      )}

      {phase === 'code' && (
        <>
          <p className="account-link-note">{`${t(lang, 'linkCodeSent')} ${normalizeEmail(address) ?? ''}`}</p>
          <input
            className="account-link-input account-link-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={LINK_CODE_LENGTH}
            placeholder={'0'.repeat(LINK_CODE_LENGTH)}
            aria-label={t(lang, 'linkCodeLabel')}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
          {/* The attempts left, only once one has been spent: stating it up front reads as a
              warning to a player who has typed nothing wrong. */}
          {attemptsLeft !== null && attemptsLeft > 0 && (
            <p className="account-link-note" role="status">
              {`${t(lang, 'linkWrongCode')} ${attemptsLeft}`}
            </p>
          )}
          <Button
            variant="primary"
            disabled={busy || !isValidLinkCode(code)}
            onClick={() => void verify()}
          >
            {busy ? t(lang, 'loading') : t(lang, 'linkConfirm')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setPhase('address')}>
            {t(lang, 'linkChangeAddress')}
          </Button>
        </>
      )}

      {phase === 'confirm' && prompt !== null && (
        <>
          {/* NAMES what is about to be destroyed before asking. The server refuses to erase
              without being told which account, so this screen is the only thing standing
              between a tap and a month of play. */}
          <p className="account-link-note" role="status">
            {t(lang, 'linkEraseWarn')}
          </p>
          <p className="account-link-stakes">
            {`${t(lang, 'linkEraseStreak')} ${prompt.streak} · ${t(lang, 'linkEraseDays')} ${prompt.days}`}
          </p>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void verify(prompt.accountId)}
          >
            {busy ? t(lang, 'loading') : t(lang, 'linkEraseConfirm')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setPhase('address')}>
            {t(lang, 'linkCancel')}
          </Button>
        </>
      )}

      {phase === 'done' && (
        <p className="account-link-note" role="status">
          {outcome === 'adopted' ? t(lang, 'linkRestored') : t(lang, 'linkSaved')}
        </p>
      )}

      {refusal && (
        <ErrorSheet
          lang={lang}
          title={refusal.title}
          note={refusal.note}
          onRetry={refusal.retry ? () => void (phase === 'code' ? verify() : send()) : undefined}
          onClose={() => setRefusal(null)}
        />
      )}
    </section>
  );
}
