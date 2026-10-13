import { describe, expect, it } from 'vitest';
import { etagRevision, revisionEtag } from './sentenceVersion';

describe('a sentence version on the wire', () => {
  it('quotes the revision as the ETag and reads it back', () => {
    expect(revisionEtag('a1b2c3d4e5f60718')).toBe('"a1b2c3d4e5f60718"');
    expect(etagRevision(revisionEtag('a1b2c3d4e5f60718'))).toBe('a1b2c3d4e5f60718');
  });

  it('reads through a weakened validator, and nothing else', () => {
    expect(etagRevision('W/"a1b2c3d4e5f60718"')).toBe('a1b2c3d4e5f60718');
    for (const bad of [null, undefined, '', 'a1b2c3d4e5f60718', '"', '""']) {
      expect(etagRevision(bad)).toBeNull();
    }
  });
});
