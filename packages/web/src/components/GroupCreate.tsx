import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { GROUP_NAME_MAX_LENGTH, GROUPS_MAX, sanitizeGroupName } from '@whippin/shared';
import LoadingWave from './LoadingWave';
import ModalHeader from './ModalHeader';
import useModalDismiss from '../hooks/useModalDismiss';
import { t, tn } from '../i18n';
import type { CreateRefusal, CreateVerdict } from '../state/groupActs';

// NAMING A NEW GROUP (#271; user-decided 2026-09-14: "it's an act of creation that should
// be satisfying, we should reuse the game prompt input and make the screen beautiful and
// more memorable" — superseding the plain text field of the same day).
//
// The screen is the GAME'S OWN PROMPT, alone: the cobalt `>`, the name in the pixel face
// as it is typed, the blinking cursor — the line a player already reads every guess into —
// over the one call, CREATE GROUP. And the creation is the SOLVE: on CREATE the prompt
// line gives way to the name INKED IN, the cobalt word with the hit's own shake, held for
// a beat before the screen folds onto the surface that opened it — the board, or the
// result's seat — already showing the new group. A group is named the way a hole is
// solved, in the same two colours.
//
// The line wears `WordInput`'s dress (`.word-input`, the prompt, the run, the cursor) over
// its own field, because the guess prompt's field is not this one: a name takes digits and
// underscores the on-screen keyboard has no keys for, so this field is EDITABLE on every
// device (the phone's own keyboard opens — the guess prompt keeps it shut for the game's
// keys) and every keystroke lands through `sanitizeGroupName`, so the field can never hold
// what the server would refuse. Enter creates; an empty name shakes the line, the invalid
// guess's own answer.
//
// **WHAT THE SERVER REFUSES IS ANSWERED HERE, AT THE LINE** — never on an error screen over
// it: a banned name shakes the line and stands in the danger ink, the name kept, with one
// note under it until it is edited; the player's own group cap (`group_limit`) is the note
// alone, and CREATE goes dark for the screen's life (a cap is a state, not a typo). The
// note hangs under the line out of the flow, so nothing moves when it speaks.
const INKED_MS = 1100;

export default function GroupCreate({
  lang,
  busy,
  onCreate,
  onClose,
}: {
  lang: string;
  busy: boolean;
  // The sanitized, non-empty name. Resolves `created` once the group exists — the screen
  // then plays the name inked in and folds itself; a refusal this screen answers at its line;
  // anything else keeps it up with the name kept while the caller's error surface speaks.
  onCreate: (name: string) => Promise<CreateVerdict>;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('fade-out');
  const [name, setName] = useState('');
  const [shaking, setShaking] = useState(false);
  const [inked, setInked] = useState(false);
  const [refusal, setRefusal] = useState<CreateRefusal | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const noteId = useId();

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

  // A refused name hands the caret back to the line it is to be changed on (the field was
  // disabled while the create was out, which took the focus away).
  useEffect(() => {
    if (refusal === 'name' && !busy) field.current?.focus({ preventScroll: true });
  }, [refusal, busy]);

  const shake = () => {
    setShaking(false);
    requestAnimationFrame(() => setShaking(true));
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || inked || refusal === 'limit') return;
    if (name.length === 0) {
      shake();
      return;
    }
    const verdict = await onCreate(name);
    if (verdict === 'created') {
      setInked(true);
      return;
    }
    if (verdict === 'name' || verdict === 'limit') setRefusal(verdict);
    if (verdict === 'name') shake();
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setName(sanitizeGroupName(event.target.value));
    // A refused NAME stands until it is edited; the cap stands for the screen's life.
    if (refusal === 'name') setRefusal(null);
  };
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
      <ModalHeader lang={lang} title={t(lang, 'groupNew')} back onClose={beginClose} />

      <form className="group-create" onSubmit={(event) => void submit(event)}>
        <div className="group-create-stage">
          {inked ? (
            <span className="group-create-word" role="status">
              {name}
            </span>
          ) : (
            <div
              className={`word-input${shaking ? ' invalid' : ''}${refusal === 'name' ? ' refused' : ''}`}
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
                aria-invalid={refusal === 'name' || undefined}
                aria-describedby={refusal !== null ? noteId : undefined}
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
          {/* The refusal's note, under the line in the stage's air (a live region that exists
              before it speaks). */}
          <div className="group-create-note" role="status">
            {refusal !== null && (
              <p id={noteId} className="account-note account-note-center danger">
                {refusal === 'name' ? t(lang, 'groupNameRejectedNote') : tn(lang, 'groupLimitNote', GROUPS_MAX)}
              </p>
            )}
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || inked || refusal === 'limit'}>
          {busy ? <LoadingWave text={t(lang, 'loading')} /> : t(lang, 'groupCreate')}
        </button>
      </form>
    </dialog>,
    document.body,
  );
}
