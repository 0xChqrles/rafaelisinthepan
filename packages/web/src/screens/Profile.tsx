import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  anonName,
  AVATAR_CELLS,
  AVATAR_PALETTES,
  blankAvatar,
  decodeAvatar,
  defaultAvatar,
  encodeAvatar,
  sanitizeName,
  NAME_MAX_LENGTH,
} from '@whippin/shared';
import { isUnknownDeviceAnswer, parseProfile, postProfileBody, profileUrl } from '../api';
import {
  deviceIdentity,
  ensureDeviceIdentity,
  identityEpoch,
  identityEpochOf,
  markDeviceSignedOut,
  useDeviceIdentity,
} from '../identity';
import { prefetchTurnstileTokens } from '../turnstile';
import { withoutLocalIdentityDeploy } from '../state/localIdentityDeploy';
import ErrorScreen from '../components/ErrorScreen';
import { navigate } from '../routing';
import { ACCOUNT_PATH, resolveHomeLang } from '../langs';
import { t } from '../i18n';
import Avatar from '../components/Avatar';
import LoadError from '../components/LoadError';
import LoadingWave from '../components/LoadingWave';
import TopBar from '../components/TopBar';
import { useGameStore } from '../state/gameStore';
// Inline SVG (vite-plugin-svgr): the close control back to the leaderboard, painting
// with currentColor; the button's aria-label names it.
import CloseIcon from '../assets/icons/close.svg?react';

// The #188 profile editor: name, tap-to-paint 10×10 grid, and the palette picker —
// each swatch IS a palette ({bg, fg} pair, user-decided 2026-08-19: two colours,
// nothing else), worn as its GROUND, so picking a ground picks the ink with it.
// Reached from the leaderboard screen once #190 lands; until then it lives at its own
// /profile route.
//
// Show-don't-tell throughout: the grid demonstrates itself under the finger and the
// swatches show their colours — no explanatory copy anywhere.

// The name rule — alphanumerics + underscores, case kept, accents FOLDED, capped —
// is `@whippin/shared`'s `sanitizeName`, because the SERVER applies the same one
// (user-decided 2026-08-19). Every path that writes `name` here goes through it: the
// initial read, the keystrokes, the composition's commit. So the value the editor
// holds is always something the route will accept, and the save body needs no pass
// of its own.

// What the initial read settled, and the reason the editor is GATED on it: the editor
// is only meaningful against the profile the server holds. Rendering an editable blank
// while the read is in flight invites edits the response then overwrites, and a failed
// read leaves the stored profile UNKNOWN — an editor started from that guess would save
// a blank over a real profile. A 404 is not a failure: it IS the answer "never
// customized" — and since 2026-08-20 that opens the editor on the player's ASSIGNED
// identity (anonName + defaultAvatar, the exact fallback every board row already
// shows), not on a blank: an editor that opens empty while the board wears a name and
// a mark reads as broken. The assigned values are also the BASELINE, so SAVE stays
// dark until something is actually changed.
// (This is the game route's own loading / error / content shape.)
type LoadState = 'loading' | 'ready' | 'failed';

// THE ASSIGNED NAME IS A DISPLAY VALUE, NEVER A STORED ONE — one rule, both directions
// (corrected 2026-08-20 on review; the first cut adopted the pseudonym as the save
// baseline on the reasoning that "storing it changes nothing anyone sees", which is
// false: every board gates its placeholder ink on the name being EMPTY, so storing the
// pseudonym flips that player's row from the muted placeholder to full primary and
// makes them indistinguishable from someone who deliberately chose that handle — and
// freezes their name against every later generator change).
//   READ  — an empty stored name shows as the assigned pseudonym, exactly as a board
//           row shows it (so a 404 and a name-less stored profile open identically).
//   WRITE — a name still equal to the assigned pseudonym was never typed, so the body
//           carries the empty name the assigned identity derives from.
// The BASELINE therefore lives in DISPLAY space (what the field holds) and the body in
// STORAGE space. A player who deliberately types their own pseudonym stores empty and
// renders the same text in the placeholder ink — the one accepted cost of the rule.
const nameForEditor = (stored: string, publicId: string) =>
  sanitizeName(stored) || anonName(publicId);
const nameForStore = (edited: string, publicId: string) =>
  edited === anonName(publicId) ? '' : edited;

// THE ASSIGNED MARK IS A DISPLAY VALUE TOO — the name rule's other half (PR-219 round-2
// review): a drawing still equal to the assigned mark the editor OPENED ON was never
// drawn, so the body carries the EMPTY avatar ('' — "no custom mark", which every reader
// already dresses as the account-derived face). Without this half, saving a name alone
// froze the placeholder grid into the row for good — on a tokenless open, the local
// SEED's grid, a face the account never had.
//   READ  — a null stored avatar opens on the assigned mark, exactly as a board row shows it.
//   WRITE — an avatar still equal to that assigned mark stores as the empty one.
const avatarForEditor = (stored: string | null, publicId: string) =>
  stored ?? defaultAvatar(publicId);
const avatarForStore = (encoded: string, publicId: string) =>
  encoded === defaultAvatar(publicId) ? '' : encoded;

// The GUARDED save body (PR-219 round-3 review, P1): when SAVE resolves an account the
// editor did NOT load — the deploy just minted one, recovered one from a pending token, or
// adopted one from another tab under an open tokenless editor — the baseline on screen was
// a PLACEHOLDER, never that account's profile. A whole-profile upsert built from it would
// wipe whatever the account already holds: change only the placeholder name and the '' in
// `avatar` deletes a custom mark; change only the drawing and the '' in `name` deletes a
// custom name. So the save first FETCHES what the account stores and carries every
// UNTOUCHED field forward verbatim; only a field the player actually changed from the
// placeholder speaks. Exported for the contract test — the wipe is the harshest thing this
// screen can do to an account.
export function guardedSaveBody(
  edited: { name: string; avatar: string },
  baseline: { name: string; avatar: string },
  // What the placeholder derived from (the local seed, or another account's id) — the
  // store-halves compare a CHANGED field against the pseudonym/mark the player was SHOWN.
  assignedFrom: string,
  // The account's stored profile; null is the 404 "never customized", where the intended
  // save applies in full.
  server: { name: string; avatar: string | null } | null,
): { name: string; avatar: string } {
  const nameChanged = edited.name !== baseline.name;
  const avatarChanged = edited.avatar !== baseline.avatar;
  return {
    name: nameChanged ? nameForStore(edited.name, assignedFrom) : (server?.name ?? ''),
    avatar: avatarChanged ? avatarForStore(edited.avatar, assignedFrom) : (server?.avatar ?? ''),
  };
}

// The SAVE button's two orthogonal facts: its visual PHASE (the label rolls down and
// out, the dot loader drops in from the top, holds, then the label rolls back up from
// the bottom) and whether the server REFUSED the write (the line under the button).
// The label itself always reads SAVE — the button animates, it never renames itself.
type SavePhase = 'idle' | 'saving' | 'restoring';
// `account` is the DEPLOY failing (#216 rework: a tokenless SAVE creates the account
// first); nothing was created and nothing was saved, and TRY AGAIN re-runs the whole tap.
type SaveRefusal = 'name_rejected' | 'avatar_rejected' | 'account' | 'error' | null;

// The loader holds at least this long even on an instant answer — a flash of dots
// reads as a glitch — and the restore beat covers the label's roll-back animation.
const SAVE_DOTS_MIN_MS = 750;
const SAVE_RESTORE_MS = 240;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function Profile() {
  const lastLang = useGameStore((s) => s.lastLang);
  // No puzzle to take a language from: same resolution as the `/` redirect.
  const lang = resolveHomeLang(lastLang, navigator.language);

  // OPENING THE EDITOR DEPLOYS NOTHING (#216 trigger rework, user-decided 2026-08-24):
  // the identity is whatever the device holds, and SAVE is the deploy button. Reactive so
  // the devices list below appears the moment an account exists.
  const identity = useDeviceIdentity();
  const ensureLocalSeed = useGameStore((s) => s.ensureLocalSeed);
  // The id the editor's DISPLAY baseline derives from — the account when one exists, the
  // persisted local seed otherwise (the leaderboard strip's own placeholder). It is what
  // the save body's name rule compares against: a name still equal to the pseudonym THE
  // PLAYER WAS SHOWN was never typed, whichever id derived it.
  const [assignedFrom, setAssignedFrom] = useState('');
  // WHICH account's profile the editor's fields were loaded from — null for a tokenless
  // open (the placeholder). The save compares it against the account it resolves: a
  // mismatch means the baseline was never that account's profile, and the guarded path
  // (guardedSaveBody) fetches before it may upsert.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [palette, setPalette] = useState(0);
  const [cells, setCells] = useState<number[]>(() => new Array<number>(AVATAR_CELLS).fill(0));
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [refused, setRefused] = useState<SaveRefusal>(null);
  // Per-cell paint counters: a painted cell remounts keyed on its count, replaying the
  // bump animation — and ONLY a painted one, so loading a stored drawing bumps nothing.
  const [bumps, setBumps] = useState<Record<number, number>>({});
  // What the server holds (or the blank start before any save): SAVE only lights up
  // when the editor differs from it, and a successful save re-baselines.
  const [baseline, setBaseline] = useState(() => ({ name: '', avatar: blankAvatar() }));
  const [load, setLoad] = useState<LoadState>('loading');
  // Bumped by RETRY — re-runs the read the way usePuzzle's retry re-runs its fetch.
  const [attempt, setAttempt] = useState(0);

  // Read this identity's stored profile, and hold the editor back until it answers
  // (see LoadState). A 404 is the answer "never customized" and lands READY on the
  // blank start; anything else — transport, 5xx, a malformed body — is FAILED, which
  // offers RETRY rather than a blank editor that could save over the real profile.
  //
  // A TOKENLESS editor opens WITHOUT any request (#216 trigger rework): the placeholder
  // identity the local seed derives IS the answer — the same face the leaderboard strip
  // wears — and those values are the baseline, so SAVE stays dark until something is
  // actually changed. Deliberately keyed on [attempt] alone: an identity arriving under
  // an OPEN editor (a deploy elsewhere, another tab) must not reload the fields out from
  // under an edit in progress — the save path resolves the identity live.
  useEffect(() => {
    let cancelled = false;
    let epoch: string | null = null;
    setLoad('loading');
    (async () => {
      try {
        const held = deviceIdentity();
        if (held === null) {
          const seed = ensureLocalSeed();
          if (cancelled) return;
          const name = nameForEditor('', seed);
          const generated = defaultAvatar(seed);
          const decoded = decodeAvatar(generated);
          setAssignedFrom(seed);
          setLoadedFor(null);
          setName(name);
          setPalette(decoded.palette);
          setCells(decoded.cells);
          setBaseline({ name, avatar: generated });
          setLoad('ready');
          return;
        }
        epoch = identityEpochOf(held);
        const publicId = held.accountId;
        setAssignedFrom(publicId);
        setLoadedFor(publicId);
        const response = await fetch(profileUrl(publicId));
        if (cancelled || identityEpoch() !== epoch) return;
        if (response.ok) {
          const profile = parseProfile(await response.json());
          // Both READ halves: the assigned pseudonym stands in for an empty stored name,
          // the assigned mark for a null stored avatar. The name is also sanitized on the
          // way in (a no-op on anything the server stored, since it enforces the same
          // rule). The BASELINE is those same display values, or a value the editor
          // cannot reproduce would light SAVE up with nothing edited.
          const shownAvatar = avatarForEditor(profile.avatar, publicId);
          const decoded = decodeAvatar(shownAvatar);
          if (cancelled || identityEpoch() !== epoch) return;
          const name = nameForEditor(profile.name, publicId);
          setName(name);
          setPalette(decoded.palette);
          setCells(decoded.cells);
          setBaseline({ name, avatar: shownAvatar });
        } else if (response.status === 404) {
          // Never customized: open on the assigned identity the boards already show
          // (see the gating note above) — the same READ half, over an empty name.
          const name = nameForEditor('', publicId);
          const generated = defaultAvatar(publicId);
          const decoded = decodeAvatar(generated);
          setName(name);
          setPalette(decoded.palette);
          setCells(decoded.cells);
          setBaseline({ name, avatar: generated });
        } else {
          setLoad('failed');
          return;
        }
        setLoad('ready');
      } catch {
        // App remounts on an identity departure, but the fence is still explicit here:
        // a late malformed body/fetch failure from A must not turn B's fresh editor into a
        // failure if the component lifecycle and the answer cross in the same turn.
        if (!cancelled && (epoch === null || identityEpoch() === epoch)) setLoad('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, ensureLocalSeed]);
  // The one challenge a tokenless SAVE will spend on its deploy, in hand before the tap.
  useEffect(() => {
    if (identity === null) prefetchTurnstileTokens(1);
  }, [identity]);

  // ---- the name field. Sanitizing a CONTROLLED input's value makes React reassign
  // `node.value`, and assigning `.value` collapses the text cursor to the END of the
  // field — React's own save/restore is gated on the focused element having CHANGED
  // (`restoreSelection`), and it never does here, so nothing puts the caret back.
  // Typing at the end hides it; typing a space into the middle of a name does not.
  // So the caret is placed by hand: sanitizing the PREFIX up to the cursor gives its
  // new index exactly, which a straight index carry-over would not — folding `é` and
  // expanding `œ` both change the length before the cursor.
  const nameRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const placeCaret = useCallback(() => {
    const caret = caretRef.current;
    caretRef.current = null;
    const input = nameRef.current;
    if (caret === null || input === null || document.activeElement !== input) return;
    input.setSelectionRange(caret, caret);
  }, []);
  // On a render this rides the commit, and React's own post-event restore then finds
  // the values already equal and writes nothing.
  useLayoutEffect(placeCaret);

  // A composition (a dead key, an IME) has to be left alone while it is open: rewriting
  // the value under it kills the composition, so an AZERTY `^` would commit as `_` and
  // the `î` it was building would never arrive. The raw value is still mirrored into
  // state — the input stays controlled, so React does not reassign and the caret does
  // not move — and the rule lands on `compositionend`, over the composed character.
  const composingRef = useRef(false);
  const applyName = (raw: string, at: number | null) => {
    const next = sanitizeName(raw);
    caretRef.current = sanitizeName(raw.slice(0, at ?? raw.length)).length;
    // React rewrites a controlled input's value after the event EVEN WHEN the state
    // does not change (`finishEventHandler` flushes, then restores), so a keystroke
    // that sanitizes back onto the name already held — a space typed over an existing
    // `_` — still moves the caret, with no render for the layout effect to ride. A
    // microtask lands after that restore.
    if (next === name) queueMicrotask(placeCaret);
    setName(next);
  };

  // ---- painting. One STROKE value per gesture: starting on a painted cell erases (so
  // tap toggles), and dragging paints that same value throughout.
  const strokeRef = useRef<number | null>(null);
  const paintAt = useCallback((element: Element | null) => {
    const raw = element instanceof HTMLElement ? element.dataset.cell : undefined;
    const stroke = strokeRef.current;
    if (raw === undefined || stroke === null) return;
    const index = Number(raw);
    setCells((prev) => {
      if (prev[index] === stroke) return prev;
      setBumps((b) => ({ ...b, [index]: (b[index] ?? 0) + 1 }));
      return prev.map((v, i) => (i === index ? stroke : v));
    });
    setRefused(null);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.target instanceof HTMLElement ? e.target : null;
      const raw = target?.dataset.cell;
      if (raw === undefined) return;
      strokeRef.current = cells[Number(raw)] === 1 ? 0 : 1;
      e.currentTarget.setPointerCapture(e.pointerId);
      paintAt(target);
    },
    [cells, paintAt],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (strokeRef.current === null) return;
      // Pointer capture pins e.target to the grid, so hit-test the point instead.
      paintAt(document.elementFromPoint(e.clientX, e.clientY));
    },
    [paintAt],
  );
  const endStroke = useCallback(() => {
    strokeRef.current = null;
  }, []);

  const colors = AVATAR_PALETTES[palette];
  // The editor is FROZEN while a save runs (its two round trips can take real time on a
  // phone, and the GUARDED success path re-binds every field to the merged server truth):
  // an edit made mid-save would be silently replayed over when the answer lands — the grid
  // visibly snapping back, SAVE greying out as though the change had been stored.
  const saving = phase !== 'idle';
  // One encode per render, shared by the preview, the dirty check and the save body.
  const encoded = encodeAvatar(palette, cells);
  // No trim on either side: the rule has no room for whitespace at all (it sanitizes
  // to `_`), the baseline is sanitized on load, and the SERVER stores the body it is
  // sent verbatim — so the two strings compared here are the same two strings the
  // route holds, and the re-baseline below is exact.
  const dirty = name !== baseline.name || encoded !== baseline.avatar;

  const onSave = useCallback(async () => {
    // The last door the rule stands in: a composition still OPEN when SAVE is tapped
    // would leave `name` holding its raw mirror, so it lands here too. A no-op on every
    // settled value, and the baseline below re-reads it, so a save can never leave the
    // editor differing from what it just stored.
    const clean = sanitizeName(name);
    setName(clean);
    setPhase('saving');
    setRefused(null);
    const started = Date.now();
    // The outcome is decided while the dots run; the phases below only pace how the
    // button tells it — then the error surface says it (#216 rework), where a refusal
    // used to be an inline line.
    let outcome: SaveRefusal = null;
    let epoch: string | null = null;
    // SAVING IS A DEPLOY BUTTON (#216 trigger rework, user-decided 2026-08-24): a
    // tokenless editor creates the account on this very tap, then saves into it — one
    // tap, the button's own dots for both legs. A deploy that fails saves nothing and
    // created nothing; TRY AGAIN re-runs the whole tap.
    let current = deviceIdentity();
    if (current === null) {
      try {
        // The ONE acquisition the locally-decided username must NOT deploy into: this tap
        // carries the player's OWN typed fields a beat later, so letting the placeholder
        // race it would either lose the save or store a name nobody chose.
        current = await withoutLocalIdentityDeploy(() => ensureDeviceIdentity());
      } catch {
        current = null;
        outcome = 'account';
      }
    }
    if (current !== null) {
      epoch = identityEpochOf(current);
      // The body is STORAGE space: an untouched assigned pseudonym stores as the empty
      // name every surface derives it from (nameForStore's WRITE half) — compared against
      // the pseudonym the player was actually SHOWN (`assignedFrom`: the account's, or the
      // local seed's on a tokenless open). The baseline handling below stays in DISPLAY
      // space, so a save can never leave the editor differing from what it just stored.
      //
      // **A save into an account the editor did NOT load is GUARDED** (PR-219 round-3
      // review, P1): the baseline was a placeholder, so the account's stored profile is
      // fetched first and every untouched field carried forward verbatim — a recovered or
      // adopted account with a real profile must not have its name or mark wiped by the
      // '' an untouched placeholder field would otherwise send.
      const guarded = current.accountId !== loadedFor;
      let fields: { name: string; avatar: string } | null = null;
      if (guarded) {
        try {
          const response = await fetch(profileUrl(current.accountId));
          if (identityEpoch() !== epoch) return;
          if (response.ok) {
            const profile = parseProfile(await response.json());
            if (identityEpoch() !== epoch) return;
            fields = guardedSaveBody(
              { name: clean, avatar: encoded },
              baseline,
              assignedFrom,
              { name: profile.name, avatar: profile.avatar },
            );
          } else if (response.status === 404) {
            // Never customized: the intended save applies in full.
            fields = guardedSaveBody({ name: clean, avatar: encoded }, baseline, assignedFrom, null);
          } else {
            // What the account holds is UNKNOWN — refusing beats risking the wipe the
            // guard exists to prevent. TRY AGAIN re-runs the whole tap.
            outcome = 'error';
          }
        } catch {
          if (identityEpoch() !== epoch) return;
          outcome = 'error';
        }
      } else {
        fields = {
          name: nameForStore(clean, assignedFrom),
          avatar: avatarForStore(encoded, assignedFrom),
        };
      }
      if (fields !== null && outcome === null) {
        const body = { token: current.token, ...fields };
        try {
          const response = await postProfileBody(profileUrl(), body);
          if (identityEpoch() !== epoch) return;
          if (response.ok) {
            if (guarded) {
              // The editor is now THIS account's: re-bind it to the stored truth the save
              // just merged, in DISPLAY space — a kept server name or mark appears, the
              // placeholder identity is gone, and a further save is an ordinary one.
              const shownName = nameForEditor(body.name, current.accountId);
              const shownAvatar = avatarForEditor(body.avatar || null, current.accountId);
              const decoded = decodeAvatar(shownAvatar);
              setName(shownName);
              setPalette(decoded.palette);
              setCells(decoded.cells);
              setBaseline({ name: shownName, avatar: shownAvatar });
              setAssignedFrom(current.accountId);
              setLoadedFor(current.accountId);
            } else {
              // DISPLAY space, like the name half: the body may have stored the empty
              // avatar, but what the editor holds — and must compare against — is the
              // drawing shown.
              setBaseline({ name: clean, avatar: encoded });
            }
          } else {
            const refusal = (await response.json().catch(() => null)) as { error?: string } | null;
            if (identityEpoch() !== epoch) return;
            // A device signed out from elsewhere raises the screen that explains it; the
            // save still reports as failed, because it was. (The body was already read
            // for the moderation codes, so the shared PREDICATE decides directly.)
            if (isUnknownDeviceAnswer(response.status, refusal?.error)) {
              markDeviceSignedOut(epoch);
            }
            outcome =
              refusal?.error === 'name_rejected' || refusal?.error === 'avatar_rejected'
                ? refusal.error
                : 'error';
          }
        } catch {
          if (identityEpoch() !== epoch) return;
          outcome = 'error';
        }
      }
    }
    await sleep(Math.max(0, SAVE_DOTS_MIN_MS - (Date.now() - started)));
    if (epoch !== null && identityEpoch() !== epoch) return;
    setRefused(outcome);
    setPhase('restoring');
    await sleep(SAVE_RESTORE_MS);
    if (epoch !== null && identityEpoch() !== epoch) return;
    setPhase((held) => (held === 'restoring' ? 'idle' : held));
  }, [name, encoded, assignedFrom, baseline, loadedFor]);

  // What the error surface says for each outcome (#216 rework, replacing the inline
  // status line): the moderation refusals explain themselves and offer no retry — asking
  // again with the same value cannot help — while a transport failure and a failed deploy
  // both carry TRY AGAIN, which re-runs the whole single-tap save.
  const saveError =
    refused === 'name_rejected'
      ? { title: t(lang, 'profileNameRejected'), note: t(lang, 'profileNameRejectedNote') }
      : refused === 'avatar_rejected'
        ? { title: t(lang, 'profileAvatarRejected'), note: t(lang, 'profileAvatarRejectedNote') }
        : refused === 'account'
          ? { title: t(lang, 'failedAccount'), note: t(lang, 'failedAccountNote'), retry: true }
          : refused === 'error'
            ? { title: t(lang, 'profileSaveFailed'), note: t(lang, 'failedSaveNote'), retry: true }
            : null;

  return (
    <>
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'profileTitle')}</span>}
        right={
          // The way OUT: UP, to `/account` (#204's UX rework, 2026-08-26). This screen
          // answers ONE question now — how others see me — and `/account` is its only
          // door, so there is nothing left to guess: the old `profileReturn` dance
          // existed because the editor could be entered from either board, and the
          // account screen is where that choice now lives.
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
      {load === 'loading' && (
        <p className="status">
          <LoadingWave text={t(lang, 'loading')} />
        </p>
      )}
      {load === 'failed' && (
        <LoadError
          message={t(lang, 'failedProfile')}
          lang={lang}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {load === 'ready' && (
        <div className="profile-screen">
          <div className="profile-editor">
            <div className="profile-head">
              {/* The live preview: the drawing at the size a board row will wear it —
                  what the grid below is editing, seen as others will see it. */}
              <Avatar avatar={encoded} size={48} />
              <input
                ref={nameRef}
                className="profile-name"
                type="text"
                value={name}
                readOnly={saving}
                maxLength={NAME_MAX_LENGTH}
                placeholder={t(lang, 'profileNamePlaceholder')}
                aria-label={t(lang, 'profileNamePlaceholder')}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  applyName(e.currentTarget.value, e.currentTarget.selectionStart);
                }}
                onChange={(e) => {
                  if (composingRef.current) setName(e.target.value);
                  else applyName(e.target.value, e.target.selectionStart);
                  setRefused(null);
                }}
              />
            </div>

            {/* The palette's ONE inline variable: empty cells wear the bg itself and the
                CSS derives the canvas's darker frame from it (color-mix — computed,
                never a second hardcoded shade per palette). */}
            <div
              className="avatar-editor"
              style={{ '--cell-bg': colors.bg } as React.CSSProperties}
              role="img"
              aria-label={t(lang, 'ariaAvatarEditor')}
              onPointerDown={saving ? undefined : onPointerDown}
              onPointerMove={saving ? undefined : onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
            >
              {cells.map((value, i) => (
                <div
                  // The paint counter in the key remounts a painted cell, replaying the
                  // bump; the position keeps the identity.
                  key={`${i}:${bumps[i] ?? 0}`}
                  className={`avatar-editor-cell${bumps[i] ? ' bumped' : ''}`}
                  data-cell={i}
                  style={{ background: value === 0 ? undefined : colors.fg }}
                />
              ))}
            </div>

            {/* The palettes, shown as their BACKGROUND colour (user-decided 2026-08-19,
                superseding the foreground swatches): pick a ground, its ink comes with
                it. The drawing (the cell states) survives a switch. CLEAR shares the
                row — it acts on the same thing the swatches dress. */}
            <div className="profile-tools">
              <div className="profile-palettes">
                {AVATAR_PALETTES.map((option, index) => (
                  <button
                    key={option.name}
                    type="button"
                    className={`profile-palette${palette === index ? ' sel' : ''}`}
                    style={{ background: option.bg }}
                    aria-label={`${t(lang, 'ariaPalette')} ${option.name}`}
                    aria-pressed={palette === index}
                    disabled={saving}
                    onClick={() => {
                      setPalette(index);
                      setRefused(null);
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                className="profile-clear"
                disabled={saving || cells.every((value) => value === 0)}
                onClick={() => {
                  setCells(new Array<number>(AVATAR_CELLS).fill(0));
                  setRefused(null);
                }}
              >
                {t(lang, 'profileClear')}
              </button>
            </div>

            {/* Nothing to save = disabled, and .mix-btn:disabled::before unlights the
                device card's LED — the board itself says whether there is a change.
                While saving, the label rolls out the bottom and the dot loader drops in
                from the top; the restore beat rolls the label back up. */}
            <button
              type="button"
              // The phase class also drives the LED square (the ::before), which rolls
              // with the label — it belongs to the content, not to the button frame.
              className={`mix-btn profile-save${phase !== 'idle' ? ` ${phase}` : ''}`}
              disabled={phase !== 'idle' || !dirty}
              aria-busy={phase === 'saving'}
              onClick={onSave}
            >
              <span
                className={`save-label${phase === 'saving' ? ' out' : phase === 'restoring' ? ' back' : ''}`}
              >
                {t(lang, 'profileSave')}
              </span>
              {phase !== 'idle' && (
                <span
                  className={`save-dots${phase === 'restoring' ? ' out' : ''}`}
                  aria-hidden="true"
                >
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </button>
            {/* The save's failure, on the app's error surface (#216 rework). */}
            {saveError && (
              <ErrorScreen
                lang={lang}
                title={saveError.title}
                note={saveError.note}
                onRetry={saveError.retry ? () => void onSave() : undefined}
                onClose={() => setRefused(null)}
              />
            )}
          </div>
          {/* The account's devices, and the way to sign one out (#216). It belongs on this
              screen because this screen IS the identity screen — and only when an account
              EXISTS: a tokenless editor has no device rows to list, and asking would be a
              private read on a visit that never acted (the list appears the moment SAVE's
              deploy lands, since the identity above is reactive). */}
        </div>
      )}
    </>
  );
}
