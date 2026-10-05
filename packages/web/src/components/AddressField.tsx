// THE ADDRESS, TYPED INTO THE GAME'S OWN PROMPT: the cobalt `>`, the line in the pixel
// face, the caret in the accent — the line a player already reads every guess into
// (`WordInput`, and the group name's `GroupCreate`) — over the podium's stippled floor, the
// one mark under it that says it can be typed into.
//
// **THE FIELD IS A REAL, VISIBLE INPUT, AND THE CARET IS THE BROWSER'S**, where the guess
// prompt and the group name draw their line and caret over a hidden one. An address is the
// one line here that gets EDITED rather than retyped — a typo in the middle of
// `prenom.nom@…` is fixed in place — and it is autofilled, pasted and selected, so the
// browser keeps the text, the selection, the scrolling of a long address AND the caret: an
// `type="email"` field exposes no selection to script, so a drawn caret could only ever sit
// at the end of the line while the real one stood somewhere else. The stylesheet shapes the
// browser's own caret as the prompt's UNDERSCORE (`caret-shape`) in the accent; where that
// is not supported it is the accent bar, standing where the edit really happens.
//
// The input spans the whole line, prompt included (3px inside the column, so the focus
// brackets, standing 3px out, frame it on the column's own edges), so they frame the line the
// player is typing into rather than the text inside it. 16px is the floor of its type (iOS
// zooms the page for a focused field under it), which is also a whole size of the face.
//
// **A LONG ADDRESS STEPS THE FACE DOWN A WHOLE SIZE**, to 8px — the face's own grid — once it
// no longer fits the line at 16px, so a forty-character address still reads whole, from its
// first letter, on a phone. The field's type stays 16px (no zoom): the line is DRAWN at half
// size (`.small`, a scale of exactly one half, so every pixel of the face lands whole).

import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

// The face's advance is one em a glyph; the prompt's cell and its air are 1.5em, the caret one.
const PROMPT_EMS = 2.5;
const FIELD_PX = 16;

export default function AddressField({
  value,
  onChange,
  onEnter,
  placeholder,
  label,
  fieldRef,
  shake,
  onShaken,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  placeholder: string;
  label: string;
  fieldRef?: MutableRefObject<HTMLInputElement | null>;
  // The game's invalid gesture on the line (an Enter on an address that cannot be one).
  shake?: boolean;
  onShaken?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  // Whether the address still fits the line at the full size.
  const line = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return undefined;
    const measure = () => setRoom(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const small = room > 0 && (value.length + PROMPT_EMS) * FIELD_PX > room - 6;
  return (
    <div
      ref={line}
      className={`link-field${small ? ' small' : ''}${shake ? ' invalid' : ''}${focused ? ' focused' : ''}`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onShaken?.();
      }}
    >
      <span className="link-field-prompt" aria-hidden="true">
        &gt;
      </span>
      <input
        ref={(node) => {
          if (fieldRef) fieldRef.current = node;
        }}
        className="link-field-input"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        // The screen holds ONE input, and typing into it is the whole purpose — the caret
        // is already there, like the code step's.
        autoFocus
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onEnter();
        }}
      />
    </div>
  );
}
