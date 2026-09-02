// CONTRACT: `?error=<variant>` is a DEVELOPMENT harness for the error screen, and the one
// thing that genuinely matters about it is that a PRODUCTION build ignores the parameter —
// otherwise anyone could pop the app's failure screen over a working game by editing a URL.
// That the variants name REAL copy is the COMPILER's (`UiKey` is `keyof typeof STRINGS`,
// and the en+fr table is parity-checked by its own `satisfies`), so nothing here restates
// it. What is left is the dev gate, and the two SHAPES the screen has to be able to draw.

import { describe, expect, it } from 'vitest';
import {
  nextErrorVariant,
  ERROR_VARIANT_NAMES,
  ERROR_VARIANTS,
  errorPreviewFromSearch,
} from './errorPreview';

describe('errorPreviewFromSearch', () => {
  it('reads a named variant in development', () => {
    expect(errorPreviewFromSearch('?error=account', true)).toBe('account');
    expect(errorPreviewFromSearch('?foo=x&error=avatar', true)).toBe('avatar');
  });

  it('takes the reported variant for the bare and shorthand forms', () => {
    expect(errorPreviewFromSearch('?error', true)).toBe('account');
    expect(errorPreviewFromSearch('?error=', true)).toBe('account');
    expect(errorPreviewFromSearch('?error=1', true)).toBe('account');
  });

  it('ignores an unknown variant rather than guessing at one', () => {
    expect(errorPreviewFromSearch('?error=nope', true)).toBeNull();
    expect(errorPreviewFromSearch('?other=account', true)).toBeNull();
  });

  it('is inert outside development', () => {
    expect(errorPreviewFromSearch('?error=account', false)).toBeNull();
    expect(errorPreviewFromSearch('?error=1', false)).toBeNull();
  });
});

describe('the variant set', () => {
  it('cycles through every variant and returns to the first', () => {
    const walk = [ERROR_VARIANT_NAMES[0]];
    for (let i = 1; i < ERROR_VARIANT_NAMES.length; i += 1) {
      walk.push(nextErrorVariant(walk[walk.length - 1]));
    }
    expect(new Set(walk).size).toBe(ERROR_VARIANT_NAMES.length);
    expect(nextErrorVariant(walk[walk.length - 1])).toBe(ERROR_VARIANT_NAMES[0]);
  });
});
