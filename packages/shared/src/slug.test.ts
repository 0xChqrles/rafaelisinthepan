// CONTRACT: fold() (JS/TS) MUST be byte-identical to slug() (Python,
// packages/generation/scripts/gen_phrase.py). Both sides assert against the SAME
// fixed case table (packages/shared/fixtures/slug-cases.json) so the two languages
// can never silently diverge. See packages/generation/tests/test_slug.py for the
// Python half — if you add a case, add it to the shared JSON and BOTH stay locked.

import { describe, it, expect } from 'vitest';
import { fold } from './slug';
import cases from '../fixtures/slug-cases.json';

type Case = { in: string; out: string; desc?: string };
const table = cases as Case[];

describe('fold() — cross-language slug contract (shared case table)', () => {
  it('the shared table is substantive', () => {
    expect(table.length).toBeGreaterThan(15);
  });

  for (const c of table) {
    const label = `${JSON.stringify(c.in)} -> ${JSON.stringify(c.out)}${c.desc ? `  (${c.desc})` : ''}`;
    it(label, () => {
      expect(fold(c.in)).toBe(c.out);
    });
  }

  it('slug collisions fold to the SAME key (côté / coté -> cote)', () => {
    expect(fold('côté')).toBe('cote');
    expect(fold('coté')).toBe('cote');
    expect(fold('côté')).toBe(fold('coté'));
  });

  it('is idempotent: folding a slug yields the slug unchanged', () => {
    for (const c of table) {
      expect(fold(c.out)).toBe(c.out);
    }
  });
});
