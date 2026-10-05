// THE ADDRESS, TYPED INTO THE GAME'S OWN PROMPT: the cobalt `>` and the caret in the accent
// — the line a player already reads every guess into (`WordInput`, and the group name's
// `GroupCreate`) — over the podium's stippled floor, the one mark under it that says it can be
// typed into. The address itself is in the area's ADDRESS FACE (`--ui`, the mono every other
// place prints it in: the masthead's caption, the code step's read-back, the saved ending), at
// one size whatever its length — the moment a player hunts a typo is no moment to shrink it.
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
// zooms the page for a focused field under it). An address longer than the line scrolls
// inside it while it is edited, and shows from its FIRST letter again the moment it is left.

import { useState, type MutableRefObject } from 'react';

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
  return (
    <div
      className={`link-field${shake ? ' invalid' : ''}${focused ? ' focused' : ''}`}
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
        onBlur={(event) => {
          setFocused(false);
          event.currentTarget.scrollLeft = 0;
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onEnter();
        }}
      />
    </div>
  );
}
