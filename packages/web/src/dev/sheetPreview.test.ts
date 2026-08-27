// CONTRACT: `?sheet=<variant>` is a DEVELOPMENT harness for the error screen, and the one
// thing that genuinely matters about it is that a PRODUCTION build ignores the parameter —
// otherwise anyone could pop the app's failure screen over a working game by editing a URL.
// That the variants name REAL copy is the COMPILER's (`UiKey` is `keyof typeof STRINGS`,
// and the en+fr table is parity-checked by its own `satisfies`), so nothing here restates
// it. What is left is the dev gate, and the two SHAPES the screen has to be able to draw.

import { describe, expect, it } from 'vitest';
import {
  nextSheetVariant,
  SHEET_VARIANT_NAMES,
  SHEET_VARIANTS,
  sheetPreviewFromSearch,
} from './sheetPreview';

describe('sheetPreviewFromSearch', () => {
  it('reads a named variant in development', () => {
    expect(sheetPreviewFromSearch('?sheet=account', true)).toBe('account');
    expect(sheetPreviewFromSearch('?foo=x&sheet=avatar', true)).toBe('avatar');
  });

  it('takes the reported variant for the bare and shorthand forms', () => {
    expect(sheetPreviewFromSearch('?sheet', true)).toBe('account');
    expect(sheetPreviewFromSearch('?sheet=', true)).toBe('account');
    expect(sheetPreviewFromSearch('?sheet=1', true)).toBe('account');
  });

  it('ignores an unknown variant rather than guessing at one', () => {
    expect(sheetPreviewFromSearch('?sheet=nope', true)).toBeNull();
    expect(sheetPreviewFromSearch('?other=account', true)).toBeNull();
  });

  it('is inert outside development', () => {
    expect(sheetPreviewFromSearch('?sheet=account', false)).toBeNull();
    expect(sheetPreviewFromSearch('?sheet=1', false)).toBeNull();
  });
});

describe('the variant set', () => {
  it('covers BOTH shapes the screen has to render', () => {
    const named = Object.values(SHEET_VARIANTS);
    expect(named.some((v) => 'retry' in v)).toBe(true);
    // The moderation refusals: asking again cannot help, so the note is the answer and the
    // one button is the way out. A preview set of only retryable variants would never show
    // that layout.
    expect(named.some((v) => !('retry' in v))).toBe(true);
  });

  it('cycles through every variant and returns to the first', () => {
    const walk = [SHEET_VARIANT_NAMES[0]];
    for (let i = 1; i < SHEET_VARIANT_NAMES.length; i += 1) {
      walk.push(nextSheetVariant(walk[walk.length - 1]));
    }
    expect(new Set(walk).size).toBe(SHEET_VARIANT_NAMES.length);
    expect(nextSheetVariant(walk[walk.length - 1])).toBe(SHEET_VARIANT_NAMES[0]);
  });
});
