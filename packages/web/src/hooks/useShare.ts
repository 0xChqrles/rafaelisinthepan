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
// owns the delivery and the `share` analytics event.
const COPIED_MS = 2000;

export default function useShare(): {
  share: (text: string) => Promise<void>;
  copied: boolean;
} {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const share = useCallback(async (text: string) => {
    const isTouch =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    if (isTouch && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Whippin AI', text });
        track('share', { method: 'native' });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return; // dismissed, not failed
        // Any other native-share failure falls through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      track('share', { method: 'clipboard' });
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Clipboard blocked (insecure context / denied): there is no further browser fallback.
    }
  }, []);

  return { share, copied };
}
