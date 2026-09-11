import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FocusEvent,
  KeyboardEvent,
  MutableRefObject,
} from 'react';
import { fold } from '@whippin/shared';
import { t } from '../i18n';

// Map a physical key to the slug character(s) it contributes. The on-screen keyboard
// only exposes [a-z] + dash, but a desktop user can press accented / uppercase keys;
// fold() neutralizes those the same way it does on submit (é -> e, Œ -> oe), so physical
// typing and the on-screen keyboard drive an identical folded-slug input. Dash is
// special-cased because fold('-') trims to '' (edge-dash rule); non-letters fold to ''.
function slugChars(key: string): string {
  if (key === '-') return '-';
  return fold(key);
}

// A TOUCH SCREEN is read the way the rest of the app reads it (`Game`'s history-tap rule):
// the PRIMARY pointer is coarse. Watched rather than read once, because it can change under a
// live round — a Chromebook folded into a tablet, a phone docked to a desktop.
const TOUCH_SCREEN = '(pointer: coarse)';

function touchScreen(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(TOUCH_SCREEN).matches
  );
}

function watchTouchScreen(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(TOUCH_SCREEN);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

interface WordInputProps {
  // Current input (a folded slug prefix); also the visible prompt text.
  value: string;
  // Prompt history for Up/Down recall: the round's persisted guesses, oldest → newest.
  history: string[];
  // Puzzle language — names the field for a screen reader.
  lang: string;
  onType: (char: string) => void; // append a single validated slug char
  onBackspace: () => void; // delete the last char
  onSubmit: (value: string) => void; // submit the current guess
  onReplace: (value: string) => void; // set the whole value (history recall)
  invalidSignal: number;
  // The caller's handle on the field, so the screen can put the caret back into it after
  // a submit — the one moment the focus may be sitting on the on-screen ENTER instead.
  fieldRef?: MutableRefObject<HTMLInputElement | null>;
  // The prompt stays MOUNTED (hidden) once the round is solved so the prompt zone keeps
  // its natural height; inactive, the field is DISABLED — it holds no focus, takes no
  // keystroke, and is out of the tab order, so keys flow to the solved surface (e.g. the
  // streak screen's press-any-key) exactly as if it were unmounted.
  active?: boolean;
}

// The guess prompt: a visually hidden <input> (#267) under the terminal-style line the
// player actually reads.
//
// It carried NO field between #36 and #267. The field it had before #36 was kept focused
// by a blur→refocus dance that opened the mobile soft keyboard and flickered the viewport,
// so it was replaced by a window `keydown` listener — which worked, but left the guess with
// no focus target at all: the app answered the keyboard everywhere and belonged to it
// nowhere. The field is back, and neither problem comes back with it: on a touch screen it
// is READ-ONLY (the on-screen <Keyboard> is this game's keyboard there), and nothing ever
// refocuses it in a loop.
//
// Read-only, because `inputmode="none"` alone only keeps the phone's keyboard out of SIGHT.
// The field stays an editable one, so Android binds the keyboard app to it all the same; that
// app keeps its own copy of the word it believes it is typing, and the game rewrote the field
// under it on every tap. The two drifted apart: players on a Samsung phone saw letters come
// out two and three times, a backspace put straight back, and the keys greyed out around the
// dead prefix that left (2026-09-12). A read-only field is no text field to the browser, so no
// keyboard app is ever bound to it — and it still takes the focus and a hardware keyboard's
// keys. Opening the phone's own keyboard is #268's NATIVE switch, which lifts this.
//
// The keys are read HERE, on the field, rather than on the document: physical typing is the
// focused prompt's, so a control the player has tabbed to keeps its own Enter. The spans
// below are the drawing — the field's value said in the pixel face — and are hidden from
// assistive tech, which reads the field itself.
export default function WordInput({
  value,
  history,
  lang,
  onType,
  onBackspace,
  onSubmit,
  onReplace,
  invalidSignal,
  fieldRef,
  active = true,
}: WordInputProps) {
  const [shaking, setShaking] = useState<boolean>(false);
  const field = useRef<HTMLInputElement>(null);
  const touch = useSyncExternalStore(watchTouchScreen, touchScreen, touchScreen);

  // Prompt history for Up/Down recall (desktop nicety). The array is the round's
  // PERSISTED guesses (passed in); the cursor (index) + draft stay ephemeral.
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef<string>('');

  // THE PROMPT TAKES THE KEYBOARD when it becomes the surface that answers it: on mount,
  // and again whenever a modal that covered it closes (a native dialog hands focus back to
  // the control that opened it, which is the hole, not the prompt). Never while inactive —
  // the field is disabled then, and a disabled field cannot be focused anyway.
  useEffect(() => {
    if (active) field.current?.focus({ preventScroll: true });
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Leave browser shortcuts (Cmd/Ctrl/Alt combos) alone — Cmd+V included, which is the
    // paste handler's.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      // History is the persisted `tried` list, updated by the submit handler (a valid
      // guess -> recordGuess). Just reset the recall cursor and submit.
      historyIndexRef.current = null;
      draftRef.current = '';
      onSubmit(value);
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      historyIndexRef.current = null;
      onBackspace();
      return;
    }

    if (e.key === 'ArrowUp') {
      if (history.length === 0) return;
      e.preventDefault();
      if (historyIndexRef.current === null) {
        draftRef.current = value;
        historyIndexRef.current = history.length - 1;
      } else {
        historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
      }
      onReplace(history[historyIndexRef.current]);
      return;
    }

    if (e.key === 'ArrowDown') {
      if (historyIndexRef.current === null) return;
      e.preventDefault();
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        onReplace(history[historyIndexRef.current]);
      } else {
        historyIndexRef.current = null;
        onReplace(draftRef.current);
      }
      return;
    }

    // A single printable key -> its slug char(s), appended one at a time (a ligature
    // like œ contributes "oe"). onType validates each against the vocab prefix set, so
    // a dead-end letter is silently dropped — matching the greyed on-screen key. The
    // field's own value is never written to: the folded state above is what it shows.
    if (e.key.length === 1) {
      const chars = slugChars(e.key);
      if (!chars) return;
      e.preventDefault();
      historyIndexRef.current = null;
      for (const c of chars) onType(c);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    const chars = Array.from(text).map(slugChars).join('');
    if (!chars) return;
    e.preventDefault();
    historyIndexRef.current = null;
    for (const c of chars) onType(c);
  };

  // Nothing the player TYPES reaches this: every key the prompt answers is
  // preventDefault'ed above, and a paste has its own handler. It is the way in for text the
  // browser inserts on its own — dictation, a desktop IME's commit — folded and appended one
  // char at a time, exactly as typing is; a touch screen's read-only field never gets here.
  // React needs it too: a controlled field without an onChange must be marked read-only, and
  // off a touch screen this one is not.
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    // Only text ADDED at the end says anything; any other edit simply re-renders back to
    // `value`, which is the state's own.
    if (next.length <= value.length || !next.startsWith(value)) return;
    historyIndexRef.current = null;
    for (const c of Array.from(next.slice(value.length)).map(slugChars).join('')) onType(c);
  };

  // THE PROMPT KEEPS THE KEYBOARD. A click on the page's own background focuses nothing at
  // all (`relatedTarget: null`), and the on-screen keys deliberately take no focus either —
  // so without this one stray click on the sentence's margin would leave the game with no
  // focused control, physical typing silently dead, and nothing on screen to click back
  // into. Focus that left for another CONTROL is the player navigating and is never taken
  // back. It runs a turn later, once the browser has settled focus where it was going —
  // refocusing inside the blur itself only fights that same move.
  const keepFocus = (e: FocusEvent<HTMLInputElement>) => {
    if (e.relatedTarget !== null) return;
    const node = e.currentTarget;
    window.setTimeout(() => {
      if (!node.isConnected || node.disabled) return;
      if (document.activeElement === document.body) node.focus({ preventScroll: true });
    }, 0);
  };

  // Rejected word: keep the text (so it can be corrected) and shake the prompt.
  // Double-toggle through rAF to replay the animation even on consecutive rejects.
  useEffect(() => {
    if (!invalidSignal) return undefined;
    setShaking(false);
    const id = requestAnimationFrame(() => setShaking(true));
    return () => cancelAnimationFrame(id);
  }, [invalidSignal]);

  return (
    <div className={`word-input${shaking ? ' invalid' : ''}`} onAnimationEnd={() => setShaking(false)}>
      <input
        ref={(node) => {
          field.current = node;
          if (fieldRef) fieldRef.current = node;
        }}
        className="wi-field"
        type="text"
        // The on-screen keyboard IS the keyboard on a touch screen (#36): the field is
        // read-only there, so no keyboard app is bound to it (see above), and `none` keeps a
        // native keyboard shut wherever it stays editable (a touch laptop). Everything the
        // browser would otherwise do to a text field — complete it, correct it, capitalize
        // it, underline it — is off: the value is a folded slug, not prose.
        readOnly={touch}
        inputMode="none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label={t(lang, 'ariaGuess')}
        value={value}
        disabled={!active}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onChange={onChange}
        onBlur={keepFocus}
      />
      <span className="wi-prompt" aria-hidden="true">&gt;</span>
      {/* The typed text is the only part of the line that gives when a guess outruns its
          column, and it gives at the HEAD: `.wi-text` is the clipping window and this run is
          the full string inside it, pushed to the window's right edge (see the CSS). The
          nesting is what makes that possible — a single element cannot both clip and overflow
          its own start. It is the field's value DRAWN, so it is hidden from assistive tech:
          the field above is what a screen reader reads the guess from. */}
      <span className="wi-text" aria-hidden="true">
        <span className="wi-text-run">{value}</span>
      </span>
      <span className="wi-cursor" aria-hidden="true">_</span>
    </div>
  );
}
