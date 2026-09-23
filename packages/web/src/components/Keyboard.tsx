import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
} from 'react';
import { KEYBOARD_ROWS, canExtend } from '../game/keyboard';
// Inline SVG components (vite-plugin-svgr `?react`): they render into the DOM and paint
// with `fill="currentColor"`, so each control key's icon inherits its `color` — muted for
// backspace, accent for enter, dimmed when greyed. Icons are decorative; the button's
// aria-label names it, so the SVG is aria-hidden.
import EnterIcon from '../assets/icons/enter.svg?react';
import BackIcon from '../assets/icons/back.svg?react';
import { t } from '../i18n';

interface KeyboardProps {
  // Current input (a folded slug prefix: [a-z] + internal dashes).
  input: string;
  // Every prefix of every vocab word — decides which letters/dash stay active.
  prefixSet: Set<string>;
  // Exact existence set — decides whether Enter is active (input is a complete word).
  vocabSet: Set<string>;
  // A masked hint stands pre-typed in the prompt (the ghost): ENTER is lit with an empty
  // input (`submittable` — it is what reveals it) and EVERY LETTER IS OUT (`locked`;
  // user-decided 2026-09-22, "no letters should be available on the keyboard at this
  // point").
  submittable?: boolean;
  locked?: boolean;
  // The value the prompt's history RECALL last wrote (the caller's `replaceInput`): an input
  // change to exactly that is no keystroke, and strikes no key. Read and cleared here.
  recalled?: MutableRefObject<string | null>;
  // Puzzle language — localizes the control keys' aria labels (letters name themselves).
  lang: string;
  onType: (char: string) => void; // append a letter or dash
  onBackspace: () => void;
  onSubmit: (value: string) => void;
}

// A key that briefly shakes when a disabled key is tapped: (id, nonce). The nonce
// retriggers the CSS animation even on repeated taps of the same key.
type Shake = { id: string; nonce: number } | null;

// How long after a pointerdown a click on the keyboard is still that press's own click.
const POINTER_CLICK_MS = 1000;

// A key STRIKES when the prompt takes its keystroke: a flash of brightness that decays —
// a state, never travel (the flat keyboard's rule). Read off the INPUT changing, so a
// letter typed on a physical keyboard lights its key on the drawn one exactly as a tap
// does: the pad answers whatever types into it.
// It starts LIT at full strength and decays to whatever the key now is — the struck letter
// is often greyed by the very keystroke that struck it (few words double a letter), so the
// flash names the key's own opacity at the start and lets the key's state take it back.
// ENTER keeps its cobalt, brighter; every other key flashes a lit tile.
const STRIKE_MS = 240;
const STRIKE_FRAMES: Keyframe[] = [{ offset: 0, opacity: 1, backgroundColor: '#3d404e', color: '#ffffff' }];
const STRIKE_ENTER: Keyframe[] = [{ offset: 0, opacity: 1, filter: 'brightness(1.6)' }];

// Which key an input change is the keystroke of: one char added at the end is that char,
// one char taken off the end is backspace, a whole word submitted (the prompt clearing) is
// enter. Anything else — a recalled history entry, a reset — is no single key.
function struckKey(prev: string, next: string, vocabSet: Set<string>): string | null {
  if (next.length === prev.length + 1 && next.startsWith(prev)) return next[next.length - 1];
  if (prev.length === next.length + 1 && prev.startsWith(next)) return 'back';
  if (next === '' && prev.length > 1 && vocabSet.has(prev)) return 'enter';
  return null;
}

// The custom on-screen keyboard (issue #36). It is the keyboard on a phone: the guess
// field beside it asks for no native one (`inputmode="none"`), so the soft keyboard never
// opens over the game's own. Letters/dash that cannot extend the current input into any
// real word are greyed out; tapping a greyed key shakes it (communicates "disabled", no
// input change). Backspace is always active; Enter is active only when the input is a
// complete vocab word. Desktop physical typing drives the same input state, so the greyed
// state stays in sync regardless of input source.
//
// EVERY KEY IS AN ORDINARY BUTTON, reachable by Tab and activated by Enter or Space
// (#267) — `press` and `activate` below are how one key answers both devices exactly once.
export default function Keyboard({
  input,
  prefixSet,
  vocabSet,
  lang,
  onType,
  onBackspace,
  onSubmit,
  submittable = false,
  locked = false,
  recalled,
}: KeyboardProps) {
  const [shake, setShake] = useState<Shake>(null);
  // When a POINTER last pressed a key here — see `activate`.
  const pointerAt = useRef(-Infinity);
  // Every key's button, by id (the char, `enter`, `back`), for the strike.
  const keys = useRef(new Map<string, HTMLButtonElement>());
  const keyRef = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) keys.current.set(id, node);
    else keys.current.delete(id);
  };
  const lastInput = useRef(input);
  useEffect(() => {
    const prev = lastInput.current;
    lastInput.current = input;
    // A recall is not typed: matched on the VALUE, so a recall that changed nothing cannot
    // swallow the next real keystroke's strike.
    const recall = recalled?.current ?? null;
    if (recalled) recalled.current = null;
    if (recall === input) return;
    const id = struckKey(prev, input, vocabSet);
    const node = id === null ? undefined : keys.current.get(id);
    if (!node || typeof node.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    node.animate(id === 'enter' ? STRIKE_ENTER : STRIKE_FRAMES, { duration: STRIKE_MS, easing: 'ease-out' });
  }, [input, vocabSet]);

  const triggerShake = useCallback((id: string) => {
    setShake((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // A POINTER is answered on pointerdown, not click: instant, and `preventDefault` keeps
  // the press from moving the focus or scrolling — so the guess field beside the keyboard
  // keeps the caret and physical typing keeps working after a tap.
  const press = useCallback(
    (e: PointerEvent<HTMLButtonElement>, run: () => void) => {
      e.preventDefault();
      pointerAt.current = performance.now();
      run();
    },
    [],
  );

  // A KEYBOARD activation makes no pointerdown at all: Enter and Space on a focused button
  // arrive here as a click with no pointer behind it, which is what `detail === 0` says (a
  // real click reports how many times the pointer was pressed). Answering `click`
  // unconditionally would fire every key twice for a tap, since a pointerdown is followed
  // by one. `detail` is not the only guard (2026-09-12): a click that follows a pointerdown
  // on this keyboard within POINTER_CLICK_MS is that tap's own click whatever it reports —
  // a browser or an assistive tool that synthesizes the tap's click with `detail` 0 (iOS
  // Safari's documented double click on a first tap) must not type the letter twice.
  const activate = useCallback(
    (e: MouseEvent<HTMLButtonElement>, run: () => void) => {
      if (e.detail !== 0 || performance.now() - pointerAt.current < POINTER_CLICK_MS) return;
      run();
    },
    [],
  );

  const enterActive = vocabSet.has(input) || (input === '' && submittable);

  const renderLetter = (char: string) => {
    const active = !locked && canExtend(prefixSet, input, char);
    const shaking = shake?.id === char;
    return (
      <button
        key={char}
        ref={keyRef(char)}
        type="button"
        aria-label={char}
        aria-disabled={!active}
        className={`kb-key${active ? '' : ' kb-greyed'}${shaking ? ' kb-shake' : ''}`}
        onPointerDown={(e) => press(e, () => (active ? onType(char) : triggerShake(char)))}
        onClick={(e) => activate(e, () => (active ? onType(char) : triggerShake(char)))}
        onAnimationEnd={() => setShake((prev) => (prev?.id === char ? null : prev))}
      >
        {char}
      </button>
    );
  };

  const dashActive = !locked && canExtend(prefixSet, input, '-');
  const dashShaking = shake?.id === '-';
  const lastRowIndex = KEYBOARD_ROWS.length - 1;

  return (
    <div className="keyboard" role="group" aria-label={t(lang, 'ariaKeyboard')}>
      {KEYBOARD_ROWS.map((row, rowIndex) => (
        // Rows are fixed; index is a stable key here.
        // eslint-disable-next-line react/no-array-index-key
        <div className="kb-row" key={rowIndex}>
          {rowIndex === lastRowIndex && (
            <button
              ref={keyRef('enter')}
              type="button"
              aria-label={t(lang, 'ariaEnter')}
              aria-disabled={!enterActive}
              className={`kb-key kb-control kb-enter${enterActive ? '' : ' kb-greyed'}${
                shake?.id === 'enter' ? ' kb-shake' : ''
              }`}
              onPointerDown={(e) => press(e, () => (enterActive ? onSubmit(input) : triggerShake('enter')))}
              onClick={(e) => activate(e, () => (enterActive ? onSubmit(input) : triggerShake('enter')))}
              onAnimationEnd={() => setShake((prev) => (prev?.id === 'enter' ? null : prev))}
            >
              <EnterIcon className="kb-icon" aria-hidden />
            </button>
          )}
          {row.map(renderLetter)}
          {rowIndex === lastRowIndex && (
            <>
              <button
                ref={keyRef('-')}
                type="button"
                aria-label={t(lang, 'ariaDash')}
                aria-disabled={!dashActive}
                className={`kb-key${dashActive ? '' : ' kb-greyed'}${dashShaking ? ' kb-shake' : ''}`}
                onPointerDown={(e) => press(e, () => (dashActive ? onType('-') : triggerShake('-')))}
                onClick={(e) => activate(e, () => (dashActive ? onType('-') : triggerShake('-')))}
                onAnimationEnd={() => setShake((prev) => (prev?.id === '-' ? null : prev))}
              >
                -
              </button>
              <button
                ref={keyRef('back')}
                type="button"
                aria-label={t(lang, 'ariaBackspace')}
                className="kb-key kb-control"
                onPointerDown={(e) => press(e, onBackspace)}
                onClick={(e) => activate(e, onBackspace)}
              >
                <BackIcon className="kb-icon" aria-hidden />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
