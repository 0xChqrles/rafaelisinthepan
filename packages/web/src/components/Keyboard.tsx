import { useCallback, useState, type PointerEvent } from 'react';
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
  // Puzzle language — localizes the control keys' aria labels (letters name themselves).
  lang: string;
  onType: (char: string) => void; // append a letter or dash
  onBackspace: () => void;
  onSubmit: (value: string) => void;
}

// A key that briefly shakes when a disabled key is tapped: (id, nonce). The nonce
// retriggers the CSS animation even on repeated taps of the same key.
type Shake = { id: string; nonce: number } | null;

// The custom on-screen keyboard (issue #36). Replaces the native mobile keyboard
// entirely: keys are <button>s, so no text field is ever focused and the soft keyboard
// never opens. Letters/dash that cannot extend the current input into any real word are
// greyed out; tapping a greyed key shakes it (communicates "disabled", no input change).
// Backspace is always active; Enter is active only when the input is a complete vocab
// word. Desktop physical typing drives the same input state, so the greyed state stays
// in sync regardless of input source.
export default function Keyboard({
  input,
  prefixSet,
  vocabSet,
  lang,
  onType,
  onBackspace,
  onSubmit,
}: KeyboardProps) {
  const [shake, setShake] = useState<Shake>(null);

  const triggerShake = useCallback((id: string) => {
    setShake((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // pointerdown (not click): instant response and, with preventDefault, no focus/scroll
  // side effects — nothing to blur, nothing to zoom.
  const press = useCallback(
    (e: PointerEvent<HTMLButtonElement>, run: () => void) => {
      e.preventDefault();
      run();
    },
    [],
  );

  const enterActive = vocabSet.has(input);

  const renderLetter = (char: string) => {
    const active = canExtend(prefixSet, input, char);
    const shaking = shake?.id === char;
    return (
      <button
        key={char}
        type="button"
        aria-label={char}
        aria-disabled={!active}
        className={`kb-key${active ? '' : ' kb-greyed'}${shaking ? ' kb-shake' : ''}`}
        onPointerDown={(e) => press(e, () => (active ? onType(char) : triggerShake(char)))}
        onAnimationEnd={() => setShake((prev) => (prev?.id === char ? null : prev))}
      >
        {char}
      </button>
    );
  };

  const dashActive = canExtend(prefixSet, input, '-');
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
              type="button"
              aria-label={t(lang, 'ariaEnter')}
              aria-disabled={!enterActive}
              className={`kb-key kb-control kb-enter${enterActive ? '' : ' kb-greyed'}${
                shake?.id === 'enter' ? ' kb-shake' : ''
              }`}
              onPointerDown={(e) => press(e, () => (enterActive ? onSubmit(input) : triggerShake('enter')))}
              onAnimationEnd={() => setShake((prev) => (prev?.id === 'enter' ? null : prev))}
            >
              <EnterIcon className="kb-icon" aria-hidden />
            </button>
          )}
          {row.map(renderLetter)}
          {rowIndex === lastRowIndex && (
            <>
              <button
                type="button"
                aria-label={t(lang, 'ariaDash')}
                aria-disabled={!dashActive}
                className={`kb-key${dashActive ? '' : ' kb-greyed'}${dashShaking ? ' kb-shake' : ''}`}
                onPointerDown={(e) => press(e, () => (dashActive ? onType('-') : triggerShake('-')))}
                onAnimationEnd={() => setShake((prev) => (prev?.id === '-' ? null : prev))}
              >
                -
              </button>
              <button
                type="button"
                aria-label={t(lang, 'ariaBackspace')}
                className="kb-key kb-control"
                onPointerDown={(e) => press(e, onBackspace)}
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
