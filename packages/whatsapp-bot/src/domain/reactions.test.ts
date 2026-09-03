import { describe, expect, it } from 'vitest';
import { reactionFor } from './reactions';

describe('deterministic reactions', () => {
  it('maps a score band to one emoji and a capped run to its own', () => {
    expect(reactionFor(3, false)).toBe('🔥');
    expect(reactionFor(4, false)).toBe('👏');
    expect(reactionFor(12, false)).toBe('👍');
    expect(reactionFor(40, false)).toBe('🫡');
    expect(reactionFor(500, true)).toBe('💀');
  });
});
