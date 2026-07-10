import { describe, expect, it } from 'vitest';
import { MAX_STREAK_PREVIEW, streakPreviewFromSearch } from './streakPreview';

describe('streakPreviewFromSearch', () => {
  it('reads the previous streak in development, including zero and rollovers', () => {
    expect(streakPreviewFromSearch('?streak=0', true)).toBe(0);
    expect(streakPreviewFromSearch('?streak=9', true)).toBe(9);
    expect(streakPreviewFromSearch('?foo=x&streak=99', true)).toBe(99);
  });

  it('ignores malformed, negative, fractional, empty, and oversized values', () => {
    expect(streakPreviewFromSearch('?streak=', true)).toBeNull();
    expect(streakPreviewFromSearch('?streak=-1', true)).toBeNull();
    expect(streakPreviewFromSearch('?streak=1.5', true)).toBeNull();
    expect(streakPreviewFromSearch('?streak=nope', true)).toBeNull();
    expect(streakPreviewFromSearch(`?streak=${MAX_STREAK_PREVIEW + 1}`, true)).toBeNull();
  });

  it('is inert outside development', () => {
    expect(streakPreviewFromSearch('?streak=9', false)).toBeNull();
  });
});
