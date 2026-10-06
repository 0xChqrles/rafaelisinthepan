import { KEYBOARD_ROWS } from '../game/keyboard';

// THE KEYBOARD'S HOLD: the on-screen keyboard's footprint while its keys cannot be pressed yet
// (the word list they are greyed against is still on its way) — every key's SLOT, on the
// keyboard's own rows and at its own sizes (`.keyboard`, `.kb-row`, `.kb-key`), in the house's
// slate stipple, breathing (`.stat-slot`'s checker and beat). Nothing on it can be pressed, and a screen reader
// hears the wait from the surface that holds it. `still` holds it STILL (a wait that ended in
// failure, or the hold going out under the keys). Built once, for every place the pad waits.
export default function KeyboardHold({ still = false }: { still?: boolean }) {
  const last = KEYBOARD_ROWS.length - 1;
  return (
    <div className="keyboard kb-hold" aria-hidden="true">
      {KEYBOARD_ROWS.map((row, i) => {
        // The last row holds ENTER before its letters and the dash and BACKSPACE after them,
        // as the keyboard does.
        const slots = i === last ? ['enter', ...row, '-', 'back'] : row;
        return (
          // Rows are fixed; index is a stable key here.
          <div className="kb-row" key={i}>
            {slots.map((id) => (
              <span key={id} className={`kb-key kb-slot${still ? '' : ' breathing'}`} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
