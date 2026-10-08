// CONTRACT (day preview links, user-decided 2026-10-08): `pnpm puzzle:preview <date>` prints
// one link per supported language, each carrying the code the backend accepts for exactly
// that (lang, date); a bad or missing date or an unknown flag stops it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LANGS } from '@whippin/shared';
import { parseArgs, previewLinks } from './preview';
import { previewCodeMatches } from './previewCode';

const SECRET = 'x'.repeat(64);
const DATE = '2026-10-12';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('previewLinks', () => {
  it('prints one link per supported language, each with its own valid code', () => {
    const lines = previewLinks(SECRET, DATE, 'https://whippin.example');
    expect(lines).toHaveLength(SUPPORTED_LANGS.length);
    SUPPORTED_LANGS.forEach((lang, i) => {
      const match = lines[i].match(/^(\w+) {2}(\S+)$/);
      expect(match?.[1]).toBe(lang);
      const url = new URL(match![2]);
      expect(url.origin).toBe('https://whippin.example');
      expect(url.pathname).toBe(`/${lang}/${DATE}`);
      expect(previewCodeMatches(SECRET, lang, DATE, url.searchParams.get('preview') ?? '')).toBe(true);
    });
  });

  it('prints bare paths for the dev server when no origin is given', () => {
    for (const line of previewLinks(SECRET, DATE, '')) {
      expect(line).toMatch(/^\w+ {2}\/\w+\/2026-10-12\?preview=[0-9a-f]{16}$/);
    }
  });
});

describe('parseArgs', () => {
  function dies(argv: string[]) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    expect(() => parseArgs(argv)).toThrow('exit 1');
  }

  it('reads the date and the destination', () => {
    expect(parseArgs([DATE])).toEqual({ date: DATE, s3: false });
    expect(parseArgs([DATE, '--s3'])).toEqual({ date: DATE, s3: true });
  });

  it('dies on a missing date', () => dies([]));
  it('dies on a bad date', () => dies(['2026-13-40']));
  it('dies on an unknown flag', () => dies([DATE, '--day']));
});
