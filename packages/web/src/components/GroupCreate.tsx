import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { GROUP_NAME_MAX_LENGTH, sanitizeGroupName } from '@whippin/shared';
import LoadingWave from './LoadingWave';
import { HeaderBack } from './TopBar';
import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';
import type { LangCode } from '../langs';

// NAMING A NEW GROUP (#271; user-decided 2026-09-14: "it's an act of creation that should
// be satisfying, we should reuse the game prompt input and make the screen beautiful and
// more memorable" — superseding the plain text field of the same day).
//
// The screen is the GAME'S OWN PROMPT, alone: the cobalt `>`, the name in the pixel face
// as it is typed, the blinking cursor — the line a player already reads every guess into —
// over the one call, CREATE GROUP. And the creation is the SOLVE: on CREATE the prompt
// line gives way to the name INKED IN, the cobalt word with the hit's own shake, held for
// a beat before the screen folds onto the board already showing the new group. A group is
// named the way a hole is solved, in the same two colours.
//
// The line wears `WordInput`'s dress (`.word-input`, the prompt, the run, the cursor) over
// its own field, because the guess prompt's field is not this one: a name takes digits and
// underscores the on-screen keyboard has no keys for, so this field is EDITABLE on every
// device (the phone's own keyboard opens — the guess prompt keeps it shut for the game's
// keys) and every keystroke lands through `sanitizeGroupName`, so the field can never hold
// what the server would refuse. Enter creates; an empty name shakes the line, the invalid
// guess's own answer.
const INKED_MS = 1100;

export default function GroupCreate({
  lang,
  busy,
  onCreate,
  onClose,
}: {
  lang: LangCode;
  busy: boolean;
  // The sanitized, non-empty name. Resolves true once the group exists — the screen then
  // plays the name inked in and folds itself.
  onCreate: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('select-out');
  const [name, setName] = useState('');
  const [shaking, setShaking] = useState(false);
  const [inked, setInked] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // The prompt takes the keyboard when the screen opens, the game's own way.
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);

  // The beat: the word stands inked in, then the fold.
  useEffect(() => {
    if (!inked) return undefined;
    const id = window.setTimeout(() => beginClose(), INKED_MS);
    return () => window.clearTimeout(id);
  }, [inked, beginClose]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || inked) return;
    if (name.length === 0) {
      setShaking(false);
      requestAnimationFrame(() => setShaking(true));
      return;
    }
    if (await onCreate(name)) setInked(true);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => setName(sanitizeGroupName(event.target.value));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
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

      <form className="group-create" onSubmit={(event) => void submit(event)}>
        <div className="group-create-stage">
          {inked ? (
            <span className="group-create-word" role="status">
              {name}
            </span>
          ) : (
            <div
              className={`word-input${shaking ? ' invalid' : ''}`}
              onAnimationEnd={() => setShaking(false)}
              // A tap anywhere on the drawn line puts the caret back in the field.
              onClick={() => field.current?.focus({ preventScroll: true })}
            >
              <input
                ref={field}
                className="wi-field"
                type="text"
                value={name}
                maxLength={GROUP_NAME_MAX_LENGTH}
                aria-label={t(lang, 'groupName')}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                onChange={onChange}
                onKeyDown={onKeyDown}
              />
              <span className="wi-prompt" aria-hidden="true">
                &gt;
              </span>
              <span className="wi-text" aria-hidden="true">
                <span className="wi-text-run">{name}</span>
              </span>
              <span className="wi-cursor" aria-hidden="true">
                _
              </span>
            </div>
          )}
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || inked}>
          {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'groupCreate')}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
