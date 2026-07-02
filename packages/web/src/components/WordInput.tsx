import { useEffect, useRef, useState } from 'react';
import { fold } from '@whippin/shared';

// Map a physical key to the slug character(s) it contributes. The on-screen keyboard
// only exposes [a-z] + dash, but a desktop user can press accented / uppercase keys;
// fold() neutralizes those the same way it does on submit (é -> e, Œ -> oe), so physical
// typing and the on-screen keyboard drive an identical folded-slug input. Dash is
// special-cased because fold('-') trims to '' (edge-dash rule); non-letters fold to ''.
function slugChars(key: string): string {
  if (key === '-') return '-';
  return fold(key);
}

interface WordInputProps {
  // Current input (a folded slug prefix); also the visible prompt text.
  value: string;
  onType: (char: string) => void; // append a single validated slug char
  onBackspace: () => void; // delete the last char
  onSubmit: (value: string) => void; // submit the current guess
  onReplace: (value: string) => void; // set the whole value (history recall)
  invalidSignal: number;
}

// The guess prompt. It no longer owns a native <input>: on mobile that meant keeping a
// hidden field focused (the blur→refocus dance) which opened the soft keyboard and
// caused focus/viewport flicker (issue #36). Input now comes from two sources that both
// mutate the same folded-slug state: the on-screen <Keyboard> (taps) and the physical
// keyboard (this window keydown listener). With no focusable text field, the native
// mobile keyboard never opens. The spans below stay the visible terminal-style prompt.
export default function WordInput({ value, onType, onBackspace, onSubmit, onReplace, invalidSignal }: WordInputProps) {
  const [shaking, setShaking] = useState<boolean>(false);

  // Submitted guesses, navigable with Up/Down on a physical keyboard (desktop nicety).
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef<string>('');

  // Refs so the window listener attaches once and always reads the latest value/callbacks.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onTypeRef = useRef(onType);
  onTypeRef.current = onType;
  const onBackspaceRef = useRef(onBackspace);
  onBackspaceRef.current = onBackspace;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onReplaceRef = useRef(onReplace);
  onReplaceRef.current = onReplace;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Leave browser shortcuts (Cmd/Ctrl/Alt combos) and any real editable field alone.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const submitted = valueRef.current;
        if (submitted) historyRef.current.push(submitted);
        historyIndexRef.current = null;
        draftRef.current = '';
        onSubmitRef.current(submitted);
        return;
      }

      if (e.key === 'Backspace') {
        e.preventDefault();
        historyIndexRef.current = null;
        onBackspaceRef.current();
        return;
      }

      if (e.key === 'ArrowUp') {
        const history = historyRef.current;
        if (history.length === 0) return;
        e.preventDefault();
        if (historyIndexRef.current === null) {
          draftRef.current = valueRef.current;
          historyIndexRef.current = history.length - 1;
        } else {
          historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
        }
        onReplaceRef.current(history[historyIndexRef.current]);
        return;
      }

      if (e.key === 'ArrowDown') {
        if (historyIndexRef.current === null) return;
        e.preventDefault();
        if (historyIndexRef.current < historyRef.current.length - 1) {
          historyIndexRef.current += 1;
          onReplaceRef.current(historyRef.current[historyIndexRef.current]);
        } else {
          historyIndexRef.current = null;
          onReplaceRef.current(draftRef.current);
        }
        return;
      }

      // A single printable key -> its slug char(s), appended one at a time (a ligature
      // like œ contributes "oe"). onType validates each against the vocab prefix set, so
      // a dead-end letter is silently dropped — matching the greyed on-screen key.
      if (e.key.length === 1) {
        const chars = slugChars(e.key);
        if (!chars) return;
        e.preventDefault();
        historyIndexRef.current = null;
        for (const c of chars) onTypeRef.current(c);
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      const chars = Array.from(text).map(slugChars).join('');
      if (!chars) return;
      e.preventDefault();
      historyIndexRef.current = null;
      for (const c of chars) onTypeRef.current(c);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('paste', onPaste);
    };
  }, []);

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
      <span className="wi-prompt" aria-hidden="true">&gt;</span>
      <span className="wi-text">{value}</span>
      <span className="wi-cursor" aria-hidden="true">_</span>
    </div>
  );
}
