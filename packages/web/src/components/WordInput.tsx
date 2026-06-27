import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';

const sanitizeInput = (value: string) =>
  Array.from(value)
    .filter((char) => char === '-' || /\p{L}/u.test(char))
    .join('');

interface WordInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  invalidSignal: number;
}

// The native input receives real keyboard/mobile IME events. The spans below
// remain the visible prompt so the game keeps its terminal-like appearance.
export default function WordInput({ value, onChange, onSubmit, disabled, invalidSignal }: WordInputProps) {
  const [shaking, setShaking] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef<string>('');

  // Refs to read the latest value / callbacks without reattaching the listener
  // on every keystroke.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef<(value: string) => void>(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef<(value: string) => void>(onSubmit);
  onSubmitRef.current = onSubmit;

  const focusInput = useCallback(() => {
    if (disabled) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [disabled]);

  // Keep the real input focused while the prompt is mounted so mobile users keep
  // the keyboard and desktop users can type without first clicking the prompt.
  useEffect(() => {
    if (disabled) return undefined;
    focusInput();
    const onPointerDown = () => focusInput();
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, [disabled, focusInput]);

  useEffect(() => {
    focusInput();
  }, [focusInput, value]);

  const submitCurrentValue = useCallback(() => {
    const submitted = valueRef.current;
    if (submitted) historyRef.current.push(submitted);
    historyIndexRef.current = null;
    draftRef.current = '';
    onSubmitRef.current(submitted);
  }, []);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const next = sanitizeInput(e.target.value);
    historyIndexRef.current = null;
    onChangeRef.current(next);
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCurrentValue();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const history = historyRef.current;
      if (history.length === 0) return;

      if (historyIndexRef.current === null) {
        draftRef.current = valueRef.current;
        historyIndexRef.current = history.length - 1;
      } else {
        historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
      }

      onChangeRef.current(history[historyIndexRef.current]);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const history = historyRef.current;
      if (historyIndexRef.current === null) return;

      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        onChangeRef.current(history[historyIndexRef.current]);
      } else {
        historyIndexRef.current = null;
        onChangeRef.current(draftRef.current);
      }
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      focusInput();
    }
  }, [focusInput, submitCurrentValue]);

  const handleBlur = useCallback(() => {
    window.setTimeout(focusInput, 0);
  }, [focusInput]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = sanitizeInput(e.clipboardData.getData('text'));
    if (!pasted) return;
    historyIndexRef.current = null;
    onChangeRef.current(valueRef.current + pasted);
  }, []);

  const handlePointerDown = useCallback(() => {
    focusInput();
  }, [focusInput]);

  const handleTouchEnd = useCallback(() => {
    focusInput();
  }, [focusInput]);

  // Rejected word: keep the text (so it can be corrected) and shake the input.
  // Double-toggle through rAF to replay the animation even on consecutive rejects.
  useEffect(() => {
    if (!invalidSignal) return undefined;
    setShaking(false);
    const id = requestAnimationFrame(() => setShaking(true));
    return () => cancelAnimationFrame(id);
  }, [invalidSignal]);

  return (
    <div
      className={`word-input${shaking ? ' invalid' : ''}`}
      onAnimationEnd={() => setShaking(false)}
      onPointerDown={handlePointerDown}
      onTouchEnd={handleTouchEnd}
    >
      <input
        ref={inputRef}
        className="wi-native-input"
        value={value}
        disabled={disabled}
        aria-label="word guess"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        enterKeyHint="go"
        inputMode="text"
        spellCheck={false}
        onBlur={handleBlur}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
      <span className="wi-prompt" aria-hidden="true">&gt;</span>
      <span className="wi-text">{value}</span>
      <span className="wi-cursor" aria-hidden="true">_</span>
    </div>
  );
}
