// A PROD-REACHABLE input diagnostic (2026-09-12): `?keylog=1` draws every raw event the
// guess prompt and the on-screen keyboard receive, and what the prompt reads after each,
// in a corner of the screen. It exists because players on phones we cannot hold reported
// letters typed twice and three times, and no emulated engine reproduces it: a screenshot
// of this overlay says which handler fired, how often, and with what — which is the one
// thing a screen recording cannot. Plain DOM, installed before React, no game state
// touched. It is not a dev harness: the tab that misbehaves is a production one.
const KEEP = 40;

function describe(e: Event): string {
  const t = e.target as HTMLElement | null;
  const label = t?.closest('button')?.getAttribute('aria-label') ?? (t?.classList.contains('wi-field') ? 'field' : t?.tagName ?? '?');
  const parts = [`${e.type} ${label}`];
  if (e instanceof MouseEvent) parts.push(`detail=${e.detail}`);
  if (e instanceof PointerEvent) parts.push(e.pointerType);
  if (e instanceof KeyboardEvent) parts.push(`key=${JSON.stringify(e.key)}${e.repeat ? ' repeat' : ''}`);
  if (e instanceof InputEvent) parts.push(`${e.inputType} data=${JSON.stringify(e.data)}`);
  if (e instanceof CompositionEvent) parts.push(`data=${JSON.stringify(e.data)}`);
  if (!e.isTrusted) parts.push('UNTRUSTED');
  return parts.join(' ');
}

export function installKeylog(): void {
  const box = document.createElement('pre');
  box.setAttribute(
    'style',
    'position:fixed;top:0;left:0;z-index:2147483647;max-width:100vw;max-height:45vh;margin:0;padding:4px 6px;overflow:hidden;' +
      'font:10px/1.3 monospace;color:#0f0;background:rgba(0,0,0,.82);pointer-events:none;white-space:pre-wrap;word-break:break-all;',
  );
  document.body.append(box);
  const lines: string[] = [];
  const t0 = performance.now();
  let lastGuess = '';
  const say = (line: string) => {
    lines.push(`${Math.round(performance.now() - t0)} ${line}`);
    if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
    box.textContent = lines.join('\n');
  };
  const snapshot = () => {
    const guess = document.querySelector('.wi-text-run')?.textContent ?? '';
    if (guess !== lastGuess) {
      lastGuess = guess;
      say(`  -> guess "${guess}"`);
    }
  };
  const field = () => document.querySelector<HTMLInputElement>('.wi-field');
  say(`build ${__BUILD_ID__} coarse=${matchMedia('(pointer: coarse)').matches}`);
  say(navigator.userAgent);
  const types = [
    'pointerdown', 'pointerup', 'pointercancel', 'click', 'keydown', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout', 'paste',
  ];
  for (const type of types) {
    window.addEventListener(
      type,
      (e) => {
        const t = e.target as HTMLElement | null;
        if (!t?.closest?.('.keyboard, .wi-field')) return;
        const f = field();
        say(`${describe(e)}${f && e.type === 'focusin' ? ` readOnly=${f.readOnly}` : ''}`);
        setTimeout(snapshot, 0);
      },
      true,
    );
  }
}
