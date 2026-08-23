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
import { parseProfile, postProfileBody, profileUrl } from '../api';
import {
  deviceIdentity,
  ensureDeviceIdentity,
  identityEpoch,
  identityEpochOf,
  markDeviceSignedOut,
} from '../identity';
import { navigate } from '../routing';
import { pathForBoard, resolveHomeLang } from '../langs';
import { t } from '../i18n';
import DeviceList from '../components/DeviceList';
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

// The SAVE button's two orthogonal facts: its visual PHASE (the label rolls down and
// out, the dot loader drops in from the top, holds, then the label rolls back up from
// the bottom) and whether the server REFUSED the write (the line under the button).
// The label itself always reads SAVE — the button animates, it never renames itself.
type SavePhase = 'idle' | 'saving' | 'restoring';
type SaveRefusal = 'name_rejected' | 'avatar_rejected' | 'error' | null;

// The loader holds at least this long even on an instant answer — a flash of dots
// reads as a glitch — and the restore beat covers the label's roll-back animation.
const SAVE_DOTS_MIN_MS = 750;
const SAVE_RESTORE_MS = 240;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function Profile() {
  const lastLang = useGameStore((s) => s.lastLang);
  const lastMode = useGameStore((s) => s.lastMode);
  // Where the board that opened this editor lives — see the close control below.
  const profileReturn = useGameStore((s) => s.profileReturn);
  const setProfileReturn = useGameStore((s) => s.setProfileReturn);
  // No puzzle to take a language from: same resolution as the `/` redirect.
  const lang = resolveHomeLang(lastLang, navigator.language);

  // This device's token, resolved once by the load effect below (#216) — the editor is
  // gated on that read, so every path that needs it runs only after it is set.
  const [token, setToken] = useState('');
  // Resolved once by the load effect; the editor is gated on that read, so every path
  // that needs it (the save body's name rule) runs only after it is set.
  const [publicId, setPublicId] = useState('');
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
  useEffect(() => {
    let cancelled = false;
    let epoch: string | null = null;
    setLoad('loading');
    (async () => {
      try {
        // The identity EDITOR cannot show a player their identity without one, so opening
        // it mints one (#216) — the same act as "saving a profile" in the trigger list, one
        // beat earlier. The wired entry point is the leaderboard, which has already
        // bootstrapped; only a deep link ever mints here.
        const identity = await ensureDeviceIdentity();
        epoch = identityEpochOf(identity);
        if (cancelled || identityEpoch() !== epoch) return;
        setToken(identity.token);
        const publicId = identity.accountId;
        setPublicId(publicId);
        const response = await fetch(profileUrl(publicId));
        if (cancelled || identityEpoch() !== epoch) return;
        if (response.ok) {
          const profile = parseProfile(await response.json());
          const decoded = decodeAvatar(profile.avatar);
          if (cancelled || identityEpoch() !== epoch) return;
          // Sanitized on the way IN (so the editor can never display a value its own
          // field would refuse — a no-op on anything the server stored, since it
          // enforces the same rule), then the assigned pseudonym stands in for an
          // empty stored name: nameForEditor's READ half. The baseline is that same
          // display value, or a name the editor cannot reproduce would light SAVE up
          // with nothing edited.
          const name = nameForEditor(profile.name, publicId);
          setName(name);
          setPalette(decoded.palette);
          setCells(decoded.cells);
          setBaseline({ name, avatar: profile.avatar });
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
  }, [attempt]);

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
  // One encode per render, shared by the preview, the dirty check and the save body.
  const encoded = encodeAvatar(palette, cells);
  // No trim on either side: the rule has no room for whitespace at all (it sanitizes
  // to `_`), the baseline is sanitized on load, and the SERVER stores the body it is
  // sent verbatim — so the two strings compared here are the same two strings the
  // route holds, and the re-baseline below is exact.
  const dirty = name !== baseline.name || encoded !== baseline.avatar;

  const onSave = useCallback(async () => {
    // The editor's token is component state. A cross-tab account swap can happen between
    // the click and this callback; refuse to send that stale body, and capture the epoch
    // from the identity whose token is actually used.
    const current = deviceIdentity();
    if (!current || current.token !== token || current.accountId !== publicId) return;
    const epoch = identityEpochOf(current);
    // The last door the rule stands in: a composition still OPEN when SAVE is tapped
    // would leave `name` holding its raw mirror, so it lands here too. A no-op on every
    // settled value, and the baseline below re-reads it, so a save can never leave the
    // editor differing from what it just stored.
    const clean = sanitizeName(name);
    setName(clean);
    setPhase('saving');
    setRefused(null);
    const started = Date.now();
    // The body is STORAGE space: an untouched assigned pseudonym stores as the empty
    // name every surface derives it from (nameForStore's WRITE half). The baseline
    // below re-reads the DISPLAY value, so a save can never leave the editor differing
    // from what it just stored.
    const body = { token, name: nameForStore(clean, publicId), avatar: encoded };
    // The outcome is decided while the dots run; the phases below only pace how the
    // button tells it.
    let outcome: SaveRefusal = null;
    try {
      const response = await postProfileBody(profileUrl(), body);
      if (identityEpoch() !== epoch) return;
      if (response.ok) {
        setBaseline({ name: clean, avatar: body.avatar });
      } else {
        const refusal = (await response.json().catch(() => null)) as { error?: string } | null;
        if (identityEpoch() !== epoch) return;
        // A device signed out from elsewhere raises the screen that explains it; the save
        // still reports as failed, because it was.
        if (response.status === 401 && refusal?.error === 'unknown_device') {
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
    await sleep(Math.max(0, SAVE_DOTS_MIN_MS - (Date.now() - started)));
    if (identityEpoch() !== epoch) return;
    setRefused(outcome);
    setPhase('restoring');
    await sleep(SAVE_RESTORE_MS);
    if (identityEpoch() !== epoch) return;
    setPhase((current) => (current === 'restoring' ? 'idle' : current));
  }, [token, publicId, name, encoded]);

  const saveError =
    refused === 'name_rejected'
      ? t(lang, 'profileNameRejected')
      : refused === 'avatar_rejected'
        ? t(lang, 'profileAvatarRejected')
        : refused === 'error'
          ? t(lang, 'profileSaveFailed')
          : null;

  return (
    <>
      <TopBar
        lang={lang}
        left={<span className="topbar-title">{t(lang, 'profileTitle')}</span>}
        right={
          // The way OUT (user feedback 2026-08-20 — the screen was unleavable): back
          // to the leaderboard, this editor's wired entry point — and to the SAME one
          // that opened it (review finding, 2026-08-20). `/profile` is a global route,
          // so the board's (lang, mode) is not in the URL: the opener states it
          // (`profileReturn`), and only an editor reached with nothing set — a deep
          // link, a reload — falls back to guessing from the last loaded GAME.
          <button
            type="button"
            className="home-btn archive-close"
            aria-label={t(lang, 'ariaClose')}
            onClick={() => {
              setProfileReturn(null);
              navigate(profileReturn ?? pathForBoard(lang, lastMode ?? 'sentence'));
            }}
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
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
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
                disabled={cells.every((value) => value === 0)}
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
            {/* The save-refusal line — mounted only when a save was refused/failed, so
                an idle editor carries no empty slot. */}
            {saveError && (
              <p className="profile-status" role="status">
                {saveError}
              </p>
            )}
          </div>
          {/* The account's devices, and the way to sign one out (#216). It belongs on this
              screen because this screen IS the identity screen — and because an account with
              no devices list leaves the whole point of per-device tokens unreachable. */}
          <DeviceList lang={lang} />
        </div>
      )}
    </>
  );
}
