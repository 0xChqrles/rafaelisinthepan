import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { StreakDialogProps } from './StreakDialog';

type DialogComponent = ComponentType<StreakDialogProps>;

let loadedDialog: DialogComponent | null = null;
let dialogModulePromise: Promise<DialogComponent> | null = null;

function loadStreakDialog() {
  if (!dialogModulePromise) {
    dialogModulePromise = import('./StreakDialog')
      .then((module) => {
        loadedDialog = module.default;
        return loadedDialog;
      })
      .catch((error) => {
        // A failed idle preload must not poison the later user-visible lazy load.
        dialogModulePromise = null;
        throw error;
      });
  }
  return dialogModulePromise;
}

// Keep React Spring and the full celebration out of the startup bundle, but fetch it while
// an eligible round is idle so a normal solve still opens without a network pause.
export function preloadStreakDialog(): void {
  void loadStreakDialog().catch(() => {
    // The lazy render retries; a speculative preload failure is intentionally silent.
  });
}

export default function LazyStreakDialog(props: StreakDialogProps) {
  const [Dialog, setDialog] = useState<DialogComponent | null>(() => loadedDialog);

  useEffect(() => {
    if (Dialog) return undefined;
    let cancelled = false;
    loadStreakDialog()
      .then((component) => {
        if (!cancelled) setDialog(() => component);
      })
      .catch(() => {
        // A celebration chunk must never strand the solved flow at frame zero. If the
        // user-visible retry also fails, skip the optional modal and continue to results.
        if (!cancelled) props.onDismiss();
      });
    return () => {
      cancelled = true;
    };
  }, [Dialog, props.onDismiss]);

  return Dialog ? <Dialog {...props} /> : null;
}
