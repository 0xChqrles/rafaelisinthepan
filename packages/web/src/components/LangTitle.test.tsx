// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LangTitle from './LangTitle';

// THE TAG GIVES WAY WHEN THE NAME WOULD BE CUT, and the answer is the layout's alone. jsdom
// lays nothing out, so the name's two widths are a model of the header row: a 100px name in a
// slot that grows with the window, the tag's 24px taken from it while the tag shows. Cut with
// the tag below 350px, whole without it from 326px — so 320 → 322 widens a squeezed title that
// would STILL be cut with its tag: the step that once flip-flopped until React gave up.
const NAME_PX = 100;
const TAG_PX = 24;
const SLOT_PX = (width: number) => width - 226;

let container: HTMLDivElement;
let root: Root;
const restore: Array<() => void> = [];

function stubWidth(prop: 'scrollWidth' | 'clientWidth', get: (el: HTMLElement) => number) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return get(this);
    },
  });
  restore.push(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
  });
}

function resize(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });
}

const button = () => container.querySelector('.puzzle-title') as HTMLButtonElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const isName = (el: HTMLElement) => el.classList.contains('topbar-title');
  stubWidth('scrollWidth', (el) => (isName(el) ? NAME_PX : 0));
  stubWidth('clientWidth', (el) => {
    if (!isName(el)) return 0;
    const tagShown = !el.parentElement?.classList.contains('squeezed');
    return Math.min(NAME_PX, SLOT_PX(window.innerWidth) - (tagShown ? TAG_PX : 0));
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  while (restore.length) restore.pop()!();
  vi.unstubAllGlobals();
});

describe('LangTitle', () => {
  it('hides the tag exactly while the name would be cut beside it, and settles at every width', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.innerWidth = 320;
    act(() => root.render(<LangTitle lang="fr" title="SAUVEGARDE" />));
    expect(button().classList.contains('squeezed')).toBe(true);
    for (let width = 320; width <= 348; width += 2) {
      resize(width);
      expect(button().classList.contains('squeezed')).toBe(true);
    }
    resize(350);
    expect(button().classList.contains('squeezed')).toBe(false);
    resize(400);
    expect(button().classList.contains('squeezed')).toBe(false);
    resize(322);
    expect(button().classList.contains('squeezed')).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
