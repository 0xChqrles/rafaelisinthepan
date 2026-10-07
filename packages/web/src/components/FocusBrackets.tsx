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
// The framed box also DIMS a touch while the brackets stand on it (`data-bracketed`, the
// CSS's), so the control itself says "held" beside the frame that says "here".
//
// It answers `:focus-visible` alone, asked at focus time: a tap moves no brackets, and
// neither does the focus a click leaves on a button. It frames the control's VISIBLE box
// — a `[data-focus-box]` inside it when the control is stretched wider than what it shows
// (a drum's row, framing its chip) — and it never frames the guess field or the profile
// editor's name field (their caret is their focus), a dialog focused as a whole, or a CONTAINER focused for a screen reader
// (`tabindex="-1"` on something that is not a control). And it STANDS ONLY ON A TARGET
// THAT IS THERE to be seen and used, asked every frame it is up: never on one marked
// `data-no-frame` (the code prompt's field while it waits OFFSTAGE — focused by the address
// step's tap so iOS raises a keyboard for it, but nothing anybody can see yet), a box under
// one cell (2px) either way, or a control that is ITSELF disabled or `aria-busy` — a control
// merely inside a busy region (a day of a month still being read) is framed like any other. While
// it may not stand, the brackets hide where they last stood, the focus kept: the moment the
// target is on stage they come back, travelling to it (the code's keys, once they are the
// step). It mounts INSIDE an open dialog when the focus is there: the top layer paints
// above everything in the document, this element included.
const GAP = 3;
// The least box the brackets frame: one cell of the house's 2px either way.
const CELL = 2;

function boxOf(el: HTMLElement): Element {
  return el.querySelector('[data-focus-box]') ?? el;
}
function framable(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  if (el.matches('dialog, .wi-field, .profile-name')) return false;
  if (el.matches('[tabindex="-1"]') && !el.matches('input, button, a')) return false;
  return el.matches(':focus-visible');
}
// Whether the brackets may stand on a framable target right now (`box`, its framed box).
function standsOn(el: HTMLElement, box: DOMRect): boolean {
  if (el.closest('[data-no-frame]')) return false;
  if (el.matches(':disabled, [aria-busy="true"]')) return false;
  return box.width >= CELL && box.height >= CELL;
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
    // The box the brackets stand on (and dim), while they do.
    let marked: Element | null = null;
    const mark = (box: Element | null) => {
      if (box === marked) return;
      marked?.removeAttribute('data-bracketed');
      box?.setAttribute('data-bracketed', '');
      marked = box;
    };
    let raf = 0;
    let last = '';
    const place = () => {
      if (!target.isConnected) {
        setTarget(null);
        return;
      }
      const box = boxOf(target);
      const r = box.getBoundingClientRect();
      if (!standsOn(target, r)) {
        // Hidden where it last stood, so it travels from there when the target is back.
        el.style.visibility = 'hidden';
        mark(null);
        raf = requestAnimationFrame(place);
        return;
      }
      el.style.visibility = '';
      mark(box);
      const x = Math.round(r.left - GAP);
      const y = Math.round(r.top - GAP);
      const w = Math.round(r.width + 2 * GAP);
      const h = Math.round(r.height + 2 * GAP);
      const key = `${x},${y},${w},${h}`;
      if (key !== last) {
        last = key;
        // The very first placement is a JUMP — there is nowhere to travel from. Every later
        // one is a change on brackets that have stood somewhere, which is the travel.
        const first = !el.style.transform;
        if (first) el.style.transition = 'none';
        el.style.transform = `translate(${x}px, ${y}px)`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        if (first) {
          el.getBoundingClientRect();
          el.style.transition = '';
        }
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(raf);
      mark(null);
    };
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
