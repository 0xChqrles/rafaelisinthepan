import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AVATAR_CELLS,
  AVATAR_PALETTES,
  AVATAR_SIZE,
  decodeAvatar,
  encodeAvatar,
  isValidSecret,
  publicIdFromSecret,
} from '@whippin/shared';
import { parseProfile, postProfileBody, profileUrl } from '../api';
import { adoptPlayerSecret, playerSecret } from '../identity';
import { resolveHomeLang } from '../langs';
import { t } from '../i18n';
import TopBar from '../components/TopBar';
import { useGameStore } from '../state/gameStore';

// The #188 profile editor: name, tap-to-paint 10×10 grid, palette picker (repaints
// background + inks together), and the copyable key — the backup that doubles as device
// linking (pasting a key on another device IS the same identity). Reached from the
// leaderboard screen once #190 lands; until then it lives at its own /profile route.
//
// Show-don't-tell throughout: the grid demonstrates itself under the finger, the palette
// swatches show their colours, and the key row carries no explanatory paragraph.

const NAME_MAX = 16;

// An unpainted cell still reads as a tile (the moodboard's socket look): a light overlay
// on a dark ground, a dark one on paper — decided by the palette's own luminance.
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

  const [secret, setSecret] = useState(() => playerSecret());
  const [name, setName] = useState('');
  const [palette, setPalette] = useState(0);
  const [cells, setCells] = useState<number[]>(() => new Array<number>(AVATAR_CELLS).fill(0));
  const [ink, setInk] = useState(1);
  const [save, setSave] = useState<SaveState>('idle');
  const [copied, setCopied] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [linked, setLinked] = useState(false);

  // Load this identity's stored profile (also what makes pasting a key on a new device
  // pull the avatar drawn on the old one). A 404 — never customized — keeps the blank
  // editor; any failure is silent, the editor still works.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const publicId = await publicIdFromSecret(secret);
        const response = await fetch(profileUrl(publicId));
        if (cancelled) return;
        if (response.status === 404) {
          // This identity was never customized — a freshly LINKED key must show ITS
          // (blank) profile, not the previous identity's drawing.
          setName('');
          setPalette(0);
          setCells(new Array<number>(AVATAR_CELLS).fill(0));
          return;
        }
        if (!response.ok) return;
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

  // ---- painting. One STROKE value per gesture: starting on a cell already holding the
  // brush's ink erases (so tap toggles), and dragging paints that same value throughout.
  const strokeRef = useRef<number | null>(null);
  const paintAt = useCallback((element: Element | null) => {
    const raw = element instanceof HTMLElement ? element.dataset.cell : undefined;
    const stroke = strokeRef.current;
    if (raw === undefined || stroke === null) return;
    const index = Number(raw);
    setCells((prev) => (prev[index] === stroke ? prev : prev.map((v, i) => (i === index ? stroke : v))));
    setSave('idle');
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const target = e.target instanceof HTMLElement ? e.target : null;
      const raw = target?.dataset.cell;
      if (raw === undefined) return;
      strokeRef.current = cells[Number(raw)] === ink ? 0 : ink;
      e.currentTarget.setPointerCapture(e.pointerId);
      paintAt(target);
    },
    [cells, ink, paintAt],
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

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied: the key is on screen, selectable.
    }
  }, [secret]);

  const linkableKey = keyInput.trim().toLowerCase();
  const canLink = isValidSecret(linkableKey) && linkableKey !== secret;
  const onLink = useCallback(() => {
    if (!adoptPlayerSecret(linkableKey)) return;
    setSecret(linkableKey);
    setKeyInput('');
    setLinked(true);
    window.setTimeout(() => setLinked(false), 2000);
  }, [linkableKey]);

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
                // A cell's position is its identity.
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                className="avatar-editor-cell"
                data-cell={i}
                style={{
                  background: value === 0 ? undefined : colors.inks[value - 1],
                }}
              />
            ))}
          </div>

          {/* The brush: the palette's three inks + the eraser (background). */}
          <div className="profile-inks" role="radiogroup" aria-label={t(lang, 'ariaPalette')}>
            {[1, 2, 3, 0].map((value) => (
              <button
                key={value}
                type="button"
                className={`profile-ink${ink === value ? ' sel' : ''}${value === 0 ? ' erase' : ''}`}
                style={{ background: value === 0 ? colors.bg : colors.inks[value - 1] }}
                role="radio"
                aria-checked={ink === value}
                aria-label={value === 0 ? t(lang, 'ariaInkBackground') : `${value}`}
                onClick={() => setInk(value)}
              />
            ))}
          </div>

          {/* The palettes: switching repaints background + inks together, the drawing
              (the cell values) stays. */}
          <div className="profile-palettes">
            {AVATAR_PALETTES.map((option, index) => (
              <button
                key={option.name}
                type="button"
                className={`profile-palette${palette === index ? ' sel' : ''}`}
                aria-label={`${t(lang, 'ariaPalette')} ${option.name}`}
                aria-pressed={palette === index}
                onClick={() => {
                  setPalette(index);
                  setSave('idle');
                }}
              >
                <i style={{ background: option.bg }} />
                {option.inks.map((color) => (
                  <i key={color} style={{ background: color }} />
                ))}
              </button>
            ))}
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
            {saveError ?? ' '}
          </p>
        </div>

        {/* The key: the backup, and — pasted elsewhere — the device link. */}
        <div className="profile-keys">
          <span className="profile-key-label">{t(lang, 'profileKey')}</span>
          <div className="profile-key-row">
            <code className="profile-key">{secret}</code>
            <button type="button" className="profile-chip" onClick={onCopy}>
              {copied ? t(lang, 'copied') : t(lang, 'profileCopy')}
            </button>
          </div>
          <div className="profile-key-row">
            <input
              className="profile-key-input"
              type="text"
              value={keyInput}
              placeholder={t(lang, 'profileLinkPlaceholder')}
              aria-label={t(lang, 'profileLinkPlaceholder')}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button
              type="button"
              className="profile-chip"
              disabled={!canLink && !linked}
              onClick={onLink}
            >
              {linked
                ? t(lang, 'profileLinked')
                : keyInput.trim() && !canLink
                  ? t(lang, 'profileBadKey')
                  : t(lang, 'profileLink')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
