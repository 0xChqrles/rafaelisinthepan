import { KEYBOARD_ROWS } from '../game/keyboard';

// THE KEYBOARD'S HOLD: the on-screen keyboard's footprint while its keys cannot be pressed yet
// (the word list they are greyed against is out) — every key as an UNLIT IRON KEY (`.kb-slate`:
// the code prompt's and the archive's material, the dusk face, the stippled slate cap, the
// corners notched a cell) on the keyboard's own rows and at its own sizes (`.keyboard`,
// `.kb-row`, `.kb-key`), so the keys land exactly where their slates stood. The caps BREATHE
// while the list is out and stand STILL once it has answered — or failed (`still`). A picture:
// nothing on it is pressed, and a screen reader hears the wait from the surface that holds
// it. Built once, for every place the pad waits (the game's hold, the lesson's tray).
export default function KeyboardHold({ still = false, className = '' }: { still?: boolean; className?: string }) {
  const last = KEYBOARD_ROWS.length - 1;
  return (
    <div className={`keyboard kb-hold${still ? '' : ' breathing'}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {KEYBOARD_ROWS.map((row, r) => {
        // The row as the keyboard lays it out: ENTER, the letters, the dash and BACKSPACE on
        // the last one.
        const count = row.length + (r === last ? 3 : 0);
        return (
          // Rows are fixed; the index is a stable key.
          <div className="kb-row" key={r}>
            {Array.from({ length: count }, (_, c) => (
              <span key={c} className="kb-key kb-slate" />
            ))}
          </div>
        );
      })}
    </div>
  );
}
