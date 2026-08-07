// Buttons are pointer-only across the app: they remain native buttons for click semantics,
// disabled states and accessible names, but never enter the tab order or retain focus.
// Install before React renders so the same rule covers initial, lazy and portaled controls.
export function installButtonFocusGuard(): () => void {
  const root = document.body;

  const disableButtonsIn = (node: Node) => {
    if (node instanceof HTMLButtonElement && node.tabIndex !== -1) node.tabIndex = -1;
    if (!(node instanceof Element) && !(node instanceof DocumentFragment)) return;
    node.querySelectorAll('button').forEach((button) => {
      if (button.tabIndex !== -1) button.tabIndex = -1;
    });
  };

  disableButtonsIn(root);
  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === 'attributes') disableButtonsIn(record.target);
      record.addedNodes.forEach(disableButtonsIn);
    });
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['tabindex'],
  });

  // Prevent the browser's normal mouse-down focus without suppressing the following click.
  const preventMouseFocus = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest('button')) event.preventDefault();
  };
  // Covers touch/browser quirks and any remaining programmatic `.focus()` call.
  const releaseButtonFocus = (event: FocusEvent) => {
    if (event.target instanceof HTMLButtonElement) event.target.blur();
  };

  document.addEventListener('mousedown', preventMouseFocus, true);
  document.addEventListener('focusin', releaseButtonFocus, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('mousedown', preventMouseFocus, true);
    document.removeEventListener('focusin', releaseButtonFocus, true);
  };
}
