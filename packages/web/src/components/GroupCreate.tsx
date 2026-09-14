import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { NAME_MAX_LENGTH, sanitizeName } from '@whippin/shared';
import LoadingWave from './LoadingWave';
import { HeaderBack } from './TopBar';
import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// NAMING A NEW GROUP (#271, user-decided 2026-09-14 — the inline field under the tabs
// was "really ugly"): its own screen, the account area's shape for a step that asks ONE
// thing — the app's header row with the way back and the step's name, one field in the
// middle of the screen, the one call under it. The name takes the player name's charset
// (`sanitizeName`, applied on every keystroke so the field can never hold what the server
// would refuse), never empty. CREATE is a deploy button: a tokenless tap mints the account
// first, the button holding its loading state for both legs; the caller owns the write.
export default function GroupCreate({
  lang,
  busy,
  onCreate,
  onClose,
}: {
  lang: LangCode;
  busy: boolean;
  // The sanitized, non-empty name. The caller closes the screen once the group exists.
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('select-out');
  const [name, setName] = useState('');
  const clean = sanitizeName(name);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || clean.length === 0) return;
    onCreate(clean);
  };

  return createPortal(
    <dialog
      {...dialogProps}
      className={`wheel-dialog puzzle-select group-screen${closing ? ' closing' : ''}`}
      aria-label={t(lang, 'groupNew')}
      onClose={onClose}
    >
      <div className="modal-bar">
        <div className="topbar-inner">
          <div className="topbar-left">
            <HeaderBack
              label={t(lang, 'ariaClose')}
              onBack={() => {
                if (!closing) beginClose();
              }}
            />
            <span className="topbar-title">{t(lang, 'groupNew')}</span>
          </div>
          <div className="topbar-right" />
        </div>
      </div>

      <form className="group-create" onSubmit={submit}>
        <input
          className="group-create-input"
          type="text"
          value={name}
          maxLength={NAME_MAX_LENGTH}
          placeholder={t(lang, 'groupNamePlaceholder')}
          aria-label={t(lang, 'groupName')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          onChange={(event) => setName(sanitizeName(event.target.value))}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || clean.length === 0}>
          {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'groupCreate')}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
