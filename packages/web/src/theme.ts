import { darken } from 'polished';

// THE PRIMARY BUTTON'S GRADIENT END (user-decided 2026-09-01): the primary is the accent
// colour, flat, with a discreet diagonal gradient into a slightly DARKER accent — and that
// darker stop is DERIVED with `polished` from the live `--accent` token rather than typed
// as a second hex, so retuning the accent moves the whole button. Installed once from
// main.tsx before the first render; the CSS carries a literal fallback for the instant
// before it runs.
export const ACCENT_DEEPEN = 0.07;

export function installTheme(): void {
  const root = document.documentElement;
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
  if (!/^#[0-9a-f]{6}$/i.test(accent)) return;
  root.style.setProperty('--accent-deep', darken(ACCENT_DEEPEN, accent));
}
