import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Deadline on the exit animation's `animationend`: a generous multiple of any real exit,
// cancelled by the genuine event. Being stranded here means being stuck inside a modal, so the
// signal it waits on gets a backstop like every other one in this app.
const EXIT_FALLBACK_MS = 800;

// How a full-screen modal opens and closes, shared so two of them cannot drift (extracted
// 2026-07-27 alongside ModalHeader, when both grew an animated dismissal):
//
//   - OPENING takes focus to the DIALOG, not to the first control inside it. `showModal()`
//     otherwise focuses the first focusable descendant — which, since every modal now leads
//     with the shared header, is the close chip: the modal would appear with its dismiss
//     button already lit. Focus still lands INSIDE the dialog (the element itself, via
//     `tabIndex: -1`), so the focus trap and Escape are untouched, and nothing is ringed.
//   - CLOSING is a beat, not an event. `beginClose()` only starts it; the real
//     `dialog.close()` — the thing that fires `onClose` and lets the owner unmount — waits for
//     the exit animation to report itself done. Escape goes through the same door: a native
//     dialog closes INSTANTLY on it, so `cancel` (which is cancelable, and fires first) is
//     preventDefault'ed and turned into the same request.
//   - A BACKDROP tap is deliberately NOT a dismissal (decided 2026-07-27): the close button is
//     the way out. The streak celebration is the exception and does not use this hook — it is
//     a tap-anywhere screen by design.
//
// The caller spreads `dialogProps` onto its `<dialog>`, renders the `closing` class, and gives
// CSS an exit animation named `exitAnimation` under `.closing`.
export default function useModalDismiss(exitAnimation: string): {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  closing: boolean;
  beginClose: () => void;
  dialogProps: {
    ref: React.RefObject<HTMLDialogElement | null>;
    tabIndex: number;
    onCancel: (e: React.SyntheticEvent) => void;
    onAnimationEnd: (e: React.AnimationEvent) => void;
  };
} {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);

  // A layout effect, and the FIRST one the caller registers (call this hook at the top of the
  // component): a closed `<dialog>` is `display: none`, so anything a modal measures on open
  // has to run after this or measure a tree with no boxes at all.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.focus({ preventScroll: true });
  }, []);

  const beginClose = useCallback(() => setClosing(true), []);
  const finishClose = useCallback(() => dialogRef.current?.close(), []);

  useEffect(() => {
    if (!closing) return undefined;
    const id = window.setTimeout(finishClose, EXIT_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [closing, finishClose]);

  return {
    dialogRef,
    closing,
    beginClose,
    dialogProps: {
      ref: dialogRef,
      // Makes the dialog itself the focus target above; it is never in the tab order.
      tabIndex: -1,
      onCancel: (e) => {
        e.preventDefault();
        setClosing(true);
      },
      onAnimationEnd: (e: React.AnimationEvent) => {
        // The dialog's OWN exit, not a descendant's animation bubbling up through it.
        if (e.target === dialogRef.current && e.animationName === exitAnimation) finishClose();
      },
    },
  };
}
