// CONTRACT: what Umami receives. The hook screens every payload the script is about to
// send (`screenPayload`, the pure half of `whippinUmamiBeforeSend`):
//   - a same-site referrer is dropped (a signed share's path carries a player id);
//   - a pageview counts once per REAL path (a replace or a query-only change is no page);
//   - the group invite landing `/join/g/<groupId>` is sent as `/join/g`, on pageviews and
//     events alike: a group id is enough to join the group, so it never leaves the app.
// Asserted against the rule, not the implementation.

import { describe, expect, it } from 'vitest';
import { screenPayload } from './analytics';

const HREF = 'https://whippin.ai/fr';
const GROUP = 'abcdefghij234567';
const OTHER_GROUP = 'zyxwvutsrq765432';

describe('screenPayload — what reaches Umami', () => {
  it('sends the invite landing as ONE page, never the group id', () => {
    const first = screenPayload({ url: `/join/g/${GROUP}` }, null, HREF);
    expect(first.payload?.url).toBe('/join/g');
    expect(JSON.stringify(first.payload)).not.toContain(GROUP);
    // An absolute url and a query carry the id the same way.
    const absolute = screenPayload({ url: `https://whippin.ai/join/g/${OTHER_GROUP}?lang=en` }, null, HREF);
    expect(absolute.payload?.url).toBe('/join/g');
  });

  it('counts the landing once per REAL path: the same group again is no page, another group is', () => {
    const first = screenPayload({ url: `/join/g/${GROUP}` }, null, HREF);
    const replay = screenPayload({ url: `/join/g/${GROUP}?lang=en` }, first.lastPath, HREF);
    expect(replay.payload).toBeNull();
    const other = screenPayload({ url: `/join/g/${OTHER_GROUP}` }, first.lastPath, HREF);
    expect(other.payload?.url).toBe('/join/g');
  });

  it('scrubs an EVENT fired on the landing too', () => {
    const event = screenPayload({ name: 'tutorial', url: `/join/g/${GROUP}`, data: { action: 'start' } }, null, HREF);
    expect(event.payload).toMatchObject({ name: 'tutorial', url: '/join/g', data: { action: 'start' } });
  });

  it('leaves every other page as it is — a bonus page keeps its id', () => {
    const bonus = screenPayload({ url: '/en/bonus/1234567' }, null, HREF);
    expect(bonus.payload?.url).toBe('/en/bonus/1234567');
    expect(bonus.lastPath).toBe('/en/bonus/1234567');
    const game = screenPayload({ name: 'solve', url: '/fr/2026-09-30' }, null, HREF);
    expect(game.payload?.url).toBe('/fr/2026-09-30');
  });

  it('drops a same-site referrer and a query-only change, as before', () => {
    const shared = screenPayload({ url: '/fr', referrer: `/s/token/${GROUP}` }, null, HREF);
    expect(shared.payload).toEqual({ url: '/fr', referrer: undefined });
    expect(screenPayload({ url: '/fr?lang=en' }, shared.lastPath, HREF).payload).toBeNull();
    // A referrer from another site is kept.
    expect(screenPayload({ url: '/en', referrer: 'https://example.com/' }, null, HREF).payload?.referrer)
      .toBe('https://example.com/');
  });
});
