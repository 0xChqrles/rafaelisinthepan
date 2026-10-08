// CONTRACT: the preview code's wire name, shape and page (packages/shared/src/preview.ts) —
// one spelling for the web that forwards it, the backend that verifies it, infra that
// forwards it to the Lambda.
import { describe, expect, it } from 'vitest';
import { isPreviewCode, PREVIEW_QUERY, PREVIEW_REFUSED, previewPath } from './preview';

describe('the preview code', () => {
  it('is sixteen lowercase hex characters', () => {
    expect(isPreviewCode('0123456789abcdef')).toBe(true);
    expect(isPreviewCode('ffffffffffffffff')).toBe(true);
  });

  it('refuses any other shape, never normalizing case', () => {
    expect(isPreviewCode('0123456789ABCDEF')).toBe(false);
    expect(isPreviewCode('0123456789abcde')).toBe(false);
    expect(isPreviewCode('0123456789abcdef0')).toBe(false);
    expect(isPreviewCode('0123456789abcdeg')).toBe(false);
    expect(isPreviewCode('')).toBe(false);
  });

  it('is refused under its own error code', () => {
    expect(PREVIEW_REFUSED).toBe('preview_refused');
  });
});

describe('the preview page', () => {
  it('is the day page with the code in its query', () => {
    expect(PREVIEW_QUERY).toBe('preview');
    expect(previewPath('fr', '2026-10-12', '0123456789abcdef')).toBe(
      '/fr/2026-10-12?preview=0123456789abcdef',
    );
  });
});
