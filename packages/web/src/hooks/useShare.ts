import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '../analytics';

// How a RESULT leaves the app, for every daily. Both modes end on the same gesture — a
// touch device gets its native share sheet, everything else copies the text and says so —
// and the details are the whole of it: the AbortError that means "the user closed the
// sheet" (not a failure to fall back from), the clipboard call that legitimately throws in
// an insecure context, and the confirmation that has to be cleared on unmount. Shared
// (2026-08-06) rather than written once per result screen, which is how the sentence and
// word screens ended up with two copies of it.
//
// The caller owns the TEXT (each mode's headline, its token, its row) and the label; this
// owns the delivery and — for a RESULT — the `share` analytics event. `tracked: false`
// opts a non-result caller (the #190 invite link) out of the event: the pinned `share`
// metric means "a result left the app" (the three-event invariant), and counting invites
// into it would silently redefine what the number measures.
//
// **`share` REPORTS whether delivery reached the player** (PR-219 follow-up review):
// true when the native sheet ran (a dismissal is the player's choice, not a failed
// delivery) or the clipboard copy landed; false when BOTH refused — which is what a
// stale user activation does (navigator.share and the async clipboard each require a
// live gesture, and slow async work before the call spends it). The result screens
// ignore the report (their gesture is always fresh); the leaderboard's INVITE surfaces
// it, because a silent nothing there reads as a button that does not work.
const COPIED_MS = 2000;

export default function useShare({ tracked = true }: { tracked?: boolean } = {}): {
  share: (text: string) => Promise<boolean>;
  copied: boolean;
} {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const share = useCallback(
    async (text: string) => {
      const isTouch =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches;
      if (isTouch && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: 'Whippin AI', text });
          if (tracked) track('share', { method: 'native' });
          return true;
        } catch (err) {
          if ((err as DOMException)?.name === 'AbortError') return true; // dismissed, not failed
          // Any other native-share failure falls through to the clipboard.
        }
      }
      try {
        await navigator.clipboard.writeText(text);
        if (tracked) track('share', { method: 'clipboard' });
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
        return true;
      } catch {
        // Clipboard blocked (insecure context / denied / no gesture): nothing further the
        // browser offers — the CALLER decides whether to say so.
        return false;
      }
    },
    [tracked],
  );

  return { share, copied };
}
