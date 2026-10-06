import { useEffect } from 'react';
import type { StreakDialogProps } from './StreakDialog';
import { lazyChunk } from '../hooks/lazyChunk';

// Keep the full celebration (its canvas scene, the foil) out of the startup bundle, but
// fetch it while an eligible round is idle so a normal solve still opens without a network
// pause.
const chunk = lazyChunk<StreakDialogProps>(() => import('./StreakDialog'));

export function preloadStreakDialog(): void {
  chunk.preload();
}

export default function LazyStreakDialog(props: StreakDialogProps) {
  // A celebration chunk must never strand the solved flow at frame zero. If the
  // user-visible retry also fails, skip the optional modal and continue to results.
  const { Loaded: Dialog, failed } = chunk.useLoaded();
  const { onDismiss } = props;
  useEffect(() => {
    if (failed) onDismiss();
  }, [failed, onDismiss]);

  return Dialog ? <Dialog {...props} /> : null;
}
