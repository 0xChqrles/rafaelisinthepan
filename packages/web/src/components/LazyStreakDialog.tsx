import type { StreakDialogProps } from './StreakDialog';
import { lazyChunk } from '../hooks/lazyChunk';

// Keep React Spring and the full celebration out of the startup bundle, but fetch it while
// an eligible round is idle so a normal solve still opens without a network pause.
const chunk = lazyChunk<StreakDialogProps>(() => import('./StreakDialog'));

export function preloadStreakDialog(): void {
  chunk.preload();
}

export default function LazyStreakDialog(props: StreakDialogProps) {
  // A celebration chunk must never strand the solved flow at frame zero. If the
  // user-visible retry also fails, skip the optional modal and continue to results.
  const Dialog = chunk.useLoaded(props.onDismiss);

  return Dialog ? <Dialog {...props} /> : null;
}
