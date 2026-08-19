import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AVATAR_CELLS,
  AVATAR_PALETTES,
  blankAvatar,
  decodeAvatar,
  encodeAvatar,
  publicIdFromSecret,
} from '@whippin/shared';
import { parseProfile, postProfileBody, profileUrl } from '../api';
import { playerSecret } from '../identity';
import { resolveHomeLang } from '../langs';
import { t } from '../i18n';
import Avatar from '../components/Avatar';
import TopBar from '../components/TopBar';
import { useGameStore } from '../state/gameStore';

// The #188 profile editor: name, tap-to-paint 10×10 grid, and the foreground-colour
// picker — each swatch IS a palette ({bg, fg} pair, user-decided 2026-08-19: two
// colours, nothing else, the picker shows only the foreground). Reached from the
// leaderboard screen once #190 lands; until then it lives at its own /profile route.
//
// Show-don't-tell throughout: the grid demonstrates itself under the finger and the
// swatches show their colours — no explanatory copy anywhere.

const NAME_MAX = 16;

// The SAVE button's two orthogonal facts: its visual PHASE (the label rolls down and
// out, the dot loader drops in from the top, holds, then the label rolls back up from
// the bottom) and whether the server REFUSED the write (the line under the button).
// The label itself always reads SAVE — the button animates, it never renames itself.
type SavePhase = 'idle' | 'saving' | 'restoring';
type SaveRefusal = 'name_rejected' | 'avatar_rejected' | 'error' | null;

// The loader holds at least this long even on an instant answer — a flash of dots
// reads as a glitch — and the restore beat covers the label's roll-back animation.
const SAVE_DOTS_MIN_MS = 500;
const SAVE_RESTORE_MS = 240;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function Profile() {
  const lastLang = useGameStore((s) => s.lastLang);
  // No puzzle to take a language from: same resolution as the `/` redirect.
  const lang = resolveHomeLang(lastLang, navigator.language);

  const [secret] = useState(() => playerSecret());
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

  // Load this identity's stored profile. A 404 — never customized — keeps the blank
  // editor; any failure is silent, the editor still works.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const publicId = await publicIdFromSecret(secret);
        const response = await fetch(profileUrl(publicId));
        if (!response.ok || cancelled) return;
        const profile = parseProfile(await response.json());
        const decoded = decodeAvatar(profile.avatar);
        if (cancelled) return;
        setName(profile.name);
        setPalette(decoded.palette);
        setCells(decoded.cells);
        setBaseline({ name: profile.name, avatar: profile.avatar });
      } catch {
        // Silent: the editor's starting state stands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [secret]);

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
  const dirty = name.trim() !== baseline.name || encoded !== baseline.avatar;

  const onSave = useCallback(async () => {
    setPhase('saving');
    setRefused(null);
    const started = Date.now();
    const body = { secret, name: name.trim(), avatar: encoded };
    // The outcome is decided while the dots run; the phases below only pace how the
    // button tells it.
    let outcome: SaveRefusal = null;
    try {
      const response = await postProfileBody(profileUrl(), body);
      if (response.ok) {
        setBaseline({ name: body.name, avatar: body.avatar });
      } else {
        const refusal = (await response.json().catch(() => null)) as { error?: string } | null;
        outcome =
          refusal?.error === 'name_rejected' || refusal?.error === 'avatar_rejected'
            ? refusal.error
            : 'error';
      }
    } catch {
      outcome = 'error';
    }
    await sleep(Math.max(0, SAVE_DOTS_MIN_MS - (Date.now() - started)));
    setRefused(outcome);
    setPhase('restoring');
    await sleep(SAVE_RESTORE_MS);
    setPhase((current) => (current === 'restoring' ? 'idle' : current));
  }, [secret, name, encoded]);

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
      />
      <div className="profile-screen">
        <div className="profile-editor">
          <div className="profile-head">
            {/* The live preview: the drawing at the size a board row will wear it —
                what the grid below is editing, seen as others will see it. */}
            <Avatar avatar={encoded} size={48} />
            <input
              className="profile-name"
              type="text"
              value={name}
              maxLength={NAME_MAX}
              placeholder={t(lang, 'profileNamePlaceholder')}
              aria-label={t(lang, 'profileNamePlaceholder')}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value);
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
            className="mix-btn profile-save"
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
      </div>
    </>
  );
}
