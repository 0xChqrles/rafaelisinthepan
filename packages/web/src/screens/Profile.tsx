import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AVATAR_CELLS,
  AVATAR_PALETTES,
  decodeAvatar,
  encodeAvatar,
  publicIdFromSecret,
} from '@whippin/shared';
import { parseProfile, postProfileBody, profileUrl } from '../api';
import { playerSecret } from '../identity';
import { resolveHomeLang } from '../langs';
import { t } from '../i18n';
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

// An unpainted cell still reads as a tile (the moodboard's socket look): a light overlay
// on a dark ground, a dark one on a light ground — decided by the palette's luminance.
function ghostFor(bg: string): string {
  const v = parseInt(bg.slice(1), 16);
  const luma = ((v >> 16) & 255) * 0.299 + ((v >> 8) & 255) * 0.587 + (v & 255) * 0.114;
  return luma > 128 ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.05)';
}

type SaveState = 'idle' | 'saving' | 'saved' | 'name_rejected' | 'avatar_rejected' | 'error';

export default function Profile() {
  const lastLang = useGameStore((s) => s.lastLang);
  // No puzzle to take a language from: same resolution as the `/` redirect.
  const lang = resolveHomeLang(lastLang, navigator.language);

  const [secret] = useState(() => playerSecret());
  const [name, setName] = useState('');
  const [palette, setPalette] = useState(0);
  const [cells, setCells] = useState<number[]>(() => new Array<number>(AVATAR_CELLS).fill(0));
  const [save, setSave] = useState<SaveState>('idle');
  // Per-cell paint counters: a painted cell remounts keyed on its count, replaying the
  // bump animation — and ONLY a painted one, so loading a stored drawing bumps nothing.
  const [bumps, setBumps] = useState<Record<number, number>>({});

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
    setSave('idle');
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

  const onSave = useCallback(async () => {
    setSave('saving');
    try {
      const response = await postProfileBody(profileUrl(), {
        secret,
        name: name.trim(),
        avatar: encodeAvatar(palette, cells),
      });
      if (response.ok) {
        setSave('saved');
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'name_rejected') setSave('name_rejected');
      else if (body?.error === 'avatar_rejected') setSave('avatar_rejected');
      else setSave('error');
    } catch {
      setSave('error');
    }
  }, [secret, name, palette, cells]);

  const saveLabel =
    save === 'saving'
      ? t(lang, 'profileSaving')
      : save === 'saved'
        ? t(lang, 'profileSaved')
        : t(lang, 'profileSave');
  const saveError =
    save === 'name_rejected'
      ? t(lang, 'profileNameRejected')
      : save === 'avatar_rejected'
        ? t(lang, 'profileAvatarRejected')
        : save === 'error'
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
              setSave('idle');
            }}
          />

          <div
            className="avatar-editor"
            style={
              {
                background: colors.bg,
                '--cell-ghost': ghostFor(colors.bg),
              } as React.CSSProperties
            }
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
                    setSave('idle');
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
                setSave('idle');
              }}
            >
              {t(lang, 'profileClear')}
            </button>
          </div>

          <button
            type="button"
            className="mix-btn profile-save"
            disabled={save === 'saving'}
            onClick={onSave}
          >
            {saveLabel}
          </button>
          <p className="profile-status" role="status">
            {saveError ?? ' '}
          </p>
        </div>
      </div>
    </>
  );
}
