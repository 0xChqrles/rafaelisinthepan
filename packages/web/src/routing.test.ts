// CONTRACT (2026-09-03): `goBack` sends a player back through the BROWSER only where this
// app pushed the entry they are standing on — that is the only case where what sits behind
// it is ours. The stamp (`history.state.app`) is what says so, and the rule that keeps it
// honest is that **only a PUSH may stamp**: a replace swaps the current entry's contents and
// changes nothing behind it, so claiming one would say "ours" about somebody else's page.
//
// It is pinned because the failing case is the exact link the `?lang=` parameter exists for —
// a pasted `/privacy?lang=en`, whose entry is nobody's, where picking a language rewrites the
// URL — and because the symptom is not an error: back simply leaves the site, or in a fresh
// tab does nothing at all.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropLangParam, goBack, navigate } from './routing';

const ORIGIN = 'https://whippin.ai';

// The smallest history the module can be judged against: an ordered list of entries, each
// with its URL and its state, and a cursor. `back()` is COUNTED as well as applied — "did it
// use the browser's own back" is the whole question here, and on the first entry of a tab
// the browser's answer is to do nothing, which is the failure mode this pins.
function install(initial: string, state: unknown = null) {
  const entries: { url: string; state: unknown }[] = [{ url: initial, state }];
  let at = 0;
  let backs = 0;
  const history = {
    get state() {
      return entries[at].state;
    },
    pushState(next: unknown, _title: string, url: string) {
      entries.length = at + 1;
      entries.push({ url, state: next });
      at = entries.length - 1;
    },
    replaceState(next: unknown, _title: string, url: string) {
      entries[at] = { url, state: next };
    },
    back() {
      backs += 1;
      if (at > 0) at -= 1;
    },
  };
  const location = {
    get href() {
      return ORIGIN + entries[at].url;
    },
    get pathname() {
      return entries[at].url.split('?')[0];
    },
    get search() {
      const q = entries[at].url.indexOf('?');
      return q === -1 ? '' : entries[at].url.slice(q);
    },
  };
  vi.stubGlobal('window', { history, location, addEventListener() {}, removeEventListener() {} });
  return {
    get url() {
      return entries[at].url;
    },
    get state() {
      return history.state;
    },
    get backs() {
      return backs;
    },
    get depth() {
      return entries.length;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('history entries', () => {
  it('stamps what it PUSHES, and carries the query string across', () => {
    const h = install('/account?tutorial=1');
    navigate('/privacy');
    expect(h.url).toBe('/privacy?tutorial=1');
    expect(h.state).toEqual({ app: true });
  });

  it('never claims an entry it only REPLACED', () => {
    const h = install('/');
    navigate('/fr', { replace: true });
    expect(h.url).toBe('/fr');
    // The `/` redirect lands on an entry a pasted URL arrived at: back from there leaves the
    // site, which is exactly what the redirect's own comment promises.
    expect(h.state).toBe(null);
  });

  it('keeps the stamp an entry already had when it replaces one', () => {
    const h = install('/account');
    navigate('/privacy');
    navigate('/privacy/', { replace: true });
    expect(h.state).toEqual({ app: true });
  });
});

describe('dropLangParam', () => {
  it('removes only `lang`, and leaves the entry as it found it', () => {
    const h = install('/privacy?lang=en&tutorial=1');
    dropLangParam();
    expect(h.url).toBe('/privacy?tutorial=1');
    expect(h.state).toBe(null);
    expect(h.depth).toBe(1);
  });

  it('does nothing at all without one', () => {
    const h = install('/privacy');
    dropLangParam();
    expect(h.url).toBe('/privacy');
  });
});

describe('goBack', () => {
  it('uses the browser where this app pushed the entry', () => {
    const h = install('/account');
    navigate('/privacy');
    goBack('/account');
    expect(h.backs).toBe(1);
    expect(h.url).toBe('/account');
  });

  it('replaces with the fallback on a pasted arrival, rather than leaving the site', () => {
    const h = install('/privacy');
    goBack('/account');
    expect(h.backs).toBe(0);
    expect(h.url).toBe('/account');
    expect(h.depth).toBe(1);
  });

  it('still falls back after the pasted link picks a language', () => {
    // The `?lang=` link's own journey: land on it, overrule it with the wheel (which drops
    // the parameter), then leave. Stamping that rewrite would send the player off the site.
    const h = install('/privacy?lang=en');
    dropLangParam();
    goBack('/account');
    expect(h.backs).toBe(0);
    expect(h.url).toBe('/account');
  });
});
