// CONTRACT: there is ONE spelling of a fetch deadline in this package.
//
// `AbortSignal.timeout()` is Baseline 2024 (Safari 16.0), above Vite's browser floor, and
// the build lowers SYNTAX only — so on an older browser the API is simply missing. It is
// read as an ARGUMENT, which is what makes it vicious: the `TypeError` lands BEFORE `fetch`
// is called, so the caller sees a request that never left, on a browser where everything
// else about the app works. `timeout.ts` exists because that took production down once
// (2026-08-27: an iOS 15 iPhone stuck on ACCOUNT SETUP FAILED, retrying a bootstrap that
// could only ever fail again), and its header closes with "One spelling now, so there is no
// second copy left to forget it."
//
// It was forgotten again the same week — #204 shipped two fresh copies, one of them on
// EVERY request of the email-link flow. A comment cannot hold a rule that costs nothing to
// break and shows nothing when broken in every environment the author can reach. This test
// can, so the rule lives here now: a deadline is `timeoutSignal(ms)`, everywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
// The module that OWNS the rule: its header names the API several times, in prose.
const OWNER = 'timeout.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && name !== OWNER && name !== 'timeout.test.ts' ? [path] : [];
  });
}

// Prose is allowed to name the API — that is how the rule is explained at the call sites
// that follow it. Only CODE is checked, so block comments and whole-line `//` comments come
// out first; a trailing comment on a line of code is left in, which can only over-report.
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('fetch deadlines', () => {
  it('are spelled `timeoutSignal(ms)` — never `AbortSignal.timeout()`', () => {
    const offenders = sources(SRC)
      .filter((path) => code(readFileSync(path, 'utf8')).includes('AbortSignal.timeout'))
      .map((path) => path.slice(SRC.length));
    expect(offenders).toEqual([]);
  });

  it('has the helper the rule points at', () => {
    expect(readFileSync(join(SRC, OWNER), 'utf8')).toMatch(/export function timeoutSignal\(/);
  });
});
