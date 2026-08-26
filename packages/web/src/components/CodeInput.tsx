// The six-digit code prompt (#204's UX rework): SIX DRAWN CELLS OVER ONE REAL INPUT.
//
// The modern OTP look is six boxes — but built as six `<input>`s it breaks the three things
// that actually matter on a phone: PASTE (a code copied out of a mail app lands in one
// field), iOS/Android AUTOFILL (`autocomplete="one-time-code"` offers the code above the
// keyboard, and only for a single field), and SCREEN READERS (six unlabelled boxes are six
// unlabelled boxes). So there is exactly one input — invisible, stretched over the cells —
// and the cells are decoration painted from its value. Autofill, paste, IME and assistive
// tech all see a plain text field; the player sees the prompt.
//
// **A COMPLETE CODE IS THE INTENT: the sixth digit submits.** There is no CONFIRM button
// anywhere in this flow. WhatsApp, Signal and every bank app do this, and the alternative
// asks a player who has just typed six digits to go find a button and agree that they meant
// it. `onComplete` carries the VALUE rather than letting the parent read state, because the
// parent's state has not flushed when the sixth keystroke lands.
//
// **A WRONG CODE STAYS AT THE INPUT.** It shakes — the game's own invalid-word gesture,
// `word-shake`, at the shared amplitude — clears, and says how many tries remain in one
// line beneath. A modal for a typo is punishment; the player's next act is to type again,
// so the cursor stays where that happens.

import { useEffect, useId, useRef } from 'react';
import { LINK_CODE_LENGTH } from '@whippin/shared';

export default function CodeInput({
  value,
  onChange,
  onComplete,
  invalid,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  // Fires once the value reaches its full length, with that value.
  onComplete: (value: string) => void;
  // The last attempt was refused: the cells wear the miss red and shake.
  invalid?: boolean;
  disabled?: boolean;
  // What the ONE input is called for a screen reader. The cells are decoration.
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  // The player arrived here to type a code, so the caret is already in it — and after a
  // refusal it comes back, since the cells were just cleared for exactly that.
  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled, invalid]);

  const digits = Array.from({ length: LINK_CODE_LENGTH }, (_, i) => value[i] ?? '');

  return (
    <div
      className={`code-input${invalid ? ' invalid' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => input.current?.focus()}
    >
      <input
        ref={input}
        id={id}
        className="code-field"
        type="text"
        // NUMERIC, never `type="number"`: a number input strips leading zeros, offers
        // spinners, and on some Androids opens a keypad with no way to paste.
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={LINK_CODE_LENGTH}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          // A pasted code often arrives with spaces or a stray letter around it; keep the
          // digits and drop the rest rather than refusing the paste.
          const next = event.target.value.replace(/\D/g, '').slice(0, LINK_CODE_LENGTH);
          onChange(next);
          if (next.length === LINK_CODE_LENGTH) onComplete(next);
        }}
      />
      {digits.map((digit, i) => (
        <span
          key={i}
          className={`code-cell${digit ? ' filled' : ''}${
            !disabled && i === value.length ? ' next' : ''
          }`}
          aria-hidden="true"
        >
          {digit}
        </span>
      ))}
    </div>
  );
}
