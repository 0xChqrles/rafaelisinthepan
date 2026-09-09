import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// THE FOCUS BRACKETS (#267, user-decided 2026-09-09 — "maybe with white corner brackets
// instead of playing too much with the opacity", after a first cut that ringed every
// control in a box and a second that gave each its own colour or dim).
//
// ONE indicator for the whole app, and it is the app's own selection frame: the device
// frame's corner brackets, drawn small and sharp in `--fg` around whatever the keyboard is
// on. Never a box, never a colour, never a change to the control itself — the control
// keeps its every state, and four corners sit just outside it. Drawn ONCE, here, by one
// element that TRAVELS from control to control (the header dot's rule: translations,
// never appearances), so no component needs a focus rule of its own and nothing can be
// missed. It follows a focus that MOVES — a drum turning under it, a scroll, a resize —
// one measurement a frame while it shows, and only while it shows.
//
// It answers `:focus-visible` alone, asked at focus time: a tap moves no brackets, and
// neither does the focus a click leaves on a button. It frames the control's VISIBLE box
// — a `[data-focus-box]` inside it when the control is stretched wider than what it shows
// (a drum's row, framing its chip) — and it never frames the guess field (its caret is
// its focus), a dialog focused as a whole, or a CONTAINER focused for a screen reader
// (`tabindex="-1"` on something that is not a control — the code prompt's field carries
// that too while it waits offstage, and is a field all the same). It mounts INSIDE an
// open dialog when the focus is there: the top layer paints above everything in the
// document, this element included.
const GAP = 3;

function boxOf(el: HTMLElement): Element {
  return el.querySelector('[data-focus-box]') ?? el;
}
function framable(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  if (el.matches('dialog, .wi-field')) return false;
  if (el.matches('[tabindex="-1"]') && !el.matches('input, button, a')) return false;
  return el.matches(':focus-visible');
}

export default function FocusBrackets() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => setTarget(framable(e.target) ? e.target : null);
    // Focus leaving for NOTHING (a click on the page, a modal closing) takes the brackets
    // with it; focus leaving for another control is answered by that control's focusin.
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget === null) setTarget(null);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    // A focus that landed BEFORE this listener existed — a screen that autofocuses its
    // field in the same commit this mounts in (a direct load of the address step) — is
    // adopted rather than missed: a text field matches `:focus-visible` whichever way it
    // was focused, so the answer is the same one the event would have given.
    if (framable(document.activeElement)) setTarget(document.activeElement);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // Where the brackets live: inside the dialog that holds the focus, else the body.
  const host = target?.closest('dialog') ?? (typeof document === 'undefined' ? null : document.body);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!target || !el) return undefined;
    let raf = 0;
    let last = '';
    const place = () => {
      if (!target.isConnected) {
        setTarget(null);
        return;
      }
      const r = boxOf(target).getBoundingClientRect();
      const x = Math.round(r.left - GAP);
      const y = Math.round(r.top - GAP);
      const w = Math.round(r.width + 2 * GAP);
      const h = Math.round(r.height + 2 * GAP);
      const key = `${x},${y},${w},${h}`;
      if (key !== last) {
        last = key;
        el.style.transform = `translate(${x}px, ${y}px)`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
      }
      raf = requestAnimationFrame(place);
    };
    // The very first placement is a JUMP — there is nowhere to travel from. Every later
    // target is a change on brackets already on screen, which is the travel.
    if (!el.style.transform) {
      el.style.transition = 'none';
      place();
      el.getBoundingClientRect();
      el.style.transition = '';
    } else {
      place();
    }
    return () => cancelAnimationFrame(raf);
  }, [target]);

  if (!target || !host) return null;
  return createPortal(
    <div ref={frame} className="focus-brackets" aria-hidden="true">
      <span className="fb-corner fb-tl" />
      <span className="fb-corner fb-tr" />
      <span className="fb-corner fb-bl" />
      <span className="fb-corner fb-br" />
    </div>,
    host,
  );
}
