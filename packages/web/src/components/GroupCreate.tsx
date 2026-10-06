import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { GROUP_NAME_MAX_LENGTH, sanitizeGroupName } from '@whippin/shared';
import BusyButton from './BusyButton';
import ModalHeader from './ModalHeader';
// (For its side effect: the root's Bayer tiles the screen comes and goes through.)
import './bayerTiles';
import useModalDismiss from '../hooks/useModalDismiss';
import { t } from '../i18n';

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
const INKED_MS = 1100;

// THE NAME'S SIZE: the pixel face is crisp only at whole multiples of 8px, so the line is set
// at the LARGEST of them at which the whole prompt fits the stage — the `>`, its half em of
// air, the name and the cursor, each glyph a full em — the result count's rule
// (`countSize.ts`). A name grows the line down a step only where it would not fit; the
// inked word keeps the size the line had, so CREATE moves nothing.
const NAME_PX = [24, 16, 8] as const;
const PROMPT_EMS = 2.5;
function nameSize(width: number, glyphs: number): number {
  return NAME_PX.find((px) => (glyphs + PROMPT_EMS) * px <= width) ?? NAME_PX[NAME_PX.length - 1];
}

export default function GroupCreate({
  lang,
  busy,
  onCreate,
  onClose,
}: {
  lang: string;
  busy: boolean;
  // The sanitized, non-empty name. Resolves true once the group exists — the screen then
  // plays the name inked in and folds itself. Otherwise it stays up with the name kept, and
  // the caller's error surface speaks over it (a banned name included: one answer for one
  // code, the profile's own).
  onCreate: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { closing, beginClose, dialogProps } = useModalDismiss('board-dissolve-out');
  const [name, setName] = useState('');
  const [shaking, setShaking] = useState(false);
  const [inked, setInked] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // The stage's width, measured before the first paint and on every resize.
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    const measure = () => setRoom(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const size = room === null ? NAME_PX[0] : nameSize(room, name.length);

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
      <ModalHeader lang={lang} title={t(lang, 'groupNew')} back onClose={beginClose} />

      <form className="group-create" onSubmit={(event) => void submit(event)}>
        <div ref={stage} className="group-create-stage" style={{ fontSize: `${size}px` }}>
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
                // Held, never disabled, while the create is out: a disabled field drops the
                // focus, and the phone's keyboard with it, moving the whole screen under the
                // busy button.
                readOnly={busy}
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
        {/* Once the name is inked in, the button stands at full ink until the screen folds:
            its act has LANDED, so it is neither busy nor unavailable, and dimming it would be
            a second beat beside the ink-in. `submit` already refuses a tap from there on. */}
        <BusyButton type="submit" className="btn btn-primary" lang={lang} busy={busy}>
          {t(lang, 'groupCreate')}
        </BusyButton>
      </form>
    </dialog>,
    document.body,
  );
}
