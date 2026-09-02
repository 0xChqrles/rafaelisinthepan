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
//
// **EACH CELL LIGHTS IN ITS OWN INK** (user-decided 2026-08-28, superseding "the cells rest
// quiet and brighten to `--line-strong` as they fill"): a filled cell takes one of the SIX
// AVATAR PALETTE colours — its digit and its border together — so the row fills into a
// small spectrum as the code goes in. It is the same palette the tile above is churning
// through while it looks for the face, which is the point: the code is typed in the colours
// the account is being found in. The inks are `AccountMark`'s, addressed rather than copied,
// so the two surfaces cannot drift. An EMPTY cell stays quiet, and a refused code still
// paints the whole row red — the danger rule wins over the spectrum, because a row that
// half-kept its colours would read as a partial refusal.

import { useEffect, useId, useRef, type CSSProperties, type MutableRefObject } from 'react';
import { LINK_CODE_LENGTH } from '@whippin/shared';
import { CODE_INKS } from './AccountMark';

export default function CodeInput({
  value,
  onChange,
  onComplete,
  invalid,
  disabled,
  label,
  fieldRef,
  offstage = false,
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
  // The caller's handle on the ONE real input, so it can move focus into it INSIDE a tap
  // (`AccountEmail`'s CONTINUE) — which is the only moment iOS will raise a keyboard.
  fieldRef?: MutableRefObject<HTMLInputElement | null>;
  // Mounted, but not this step yet: hidden, out of the tab order, and taking no focus of
  // its own. It exists early so the address step's tap has something to focus.
  offstage?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  // The player arrived here to type a code, so the caret is already in it — and after a
  // refusal it comes back, since the cells were just cleared for exactly that. Never while
  // OFFSTAGE: this component is mounted from the address step on, and focusing there would
  // take the caret out of the address field the player is typing in.
  useEffect(() => {
    if (!disabled && !offstage) input.current?.focus();
  }, [disabled, invalid, offstage]);

  const digits = Array.from({ length: LINK_CODE_LENGTH }, (_, i) => value[i] ?? '');

  return (
    <div
      className={`code-input${invalid ? ' invalid' : ''}${disabled ? ' disabled' : ''}${
        offstage ? ' offstage' : ''
      }`}
      onClick={() => input.current?.focus()}
    >
      <input
        ref={(node) => {
          input.current = node;
          if (fieldRef) fieldRef.current = node;
        }}
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
        // NO `maxLength`. The browser enforces it on the RAW value, BEFORE this handler
        // runs, so a pasted " 123456 " arrives here already cut to " 12345" and the
        // sanitiser below is handed FIVE digits — nothing submits, and nothing on screen
        // says why ("Code: 123456" lands as no digits at all). Six of nine realistic paste
        // shapes failed that way. The bound is the slice below, which counts DIGITS rather
        // than characters, and a controlled `value` writes the trimmed result straight
        // back — so the field can never hold more than the code.
        aria-label={label}
        // Out of the TAB ORDER while offstage — reachable only by the deliberate focus the
        // address step's tap makes. It keeps its label and stays in the accessibility tree
        // rather than being `aria-hidden`, because focus may genuinely land here for the
        // length of the send, and moving focus into hidden content is the worse trade.
        tabIndex={offstage ? -1 : undefined}
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
          style={{ '--cell-ink': CODE_INKS[i % CODE_INKS.length] } as CSSProperties}
          aria-hidden="true"
        >
          {digit}
        </span>
      ))}
    </div>
  );
}
