import { describe, expect, it } from 'vitest';
import { createLog } from '../log';
import { createWhippinGroupReader, groupInviteUrl } from './whippinGroup';

const ID = 'abcdefghij234567';

function reader(answer: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return answer();
  }) as unknown as typeof fetch;
  return { urls, read: createWhippinGroupReader({ apiBaseUrl: 'https://api.whippin.ai', log: createLog('silent'), fetchImpl }) };
}

describe('the Whippin group a WhatsApp group plays as (user-decided 2026-09-14)', () => {
  it('links the shared invite path, with the day as the `v` a client keys its preview on', () => {
    expect(groupInviteUrl('https://whippin.ai', ID, 20711)).toBe(`https://whippin.ai/g/${ID}?v=20711`);
  });

  it('reads the public face: the group itself stands, a 404 is gone, anything else is no answer', async () => {
    const standing = reader(() => Response.json({ id: ID, name: 'le_groupe', members: [] }));
    expect(await standing.read.stands(ID)).toBe(true);
    expect(standing.urls).toEqual([`https://api.whippin.ai/groups?id=${ID}`]);
    expect(await reader(() => Response.json({ error: 'unknown_group' }, { status: 404 })).read.stands(ID)).toBe(false);
    expect(await reader(() => new Response('oops', { status: 502 })).read.stands(ID)).toBeNull();
    // A 200 is only an answer when it is THIS group's face.
    expect(await reader(() => Response.json({ id: 'zzzzzzzzzzzzzzzz' })).read.stands(ID)).toBeNull();
    expect(await reader(() => new Response('<!doctype html>', { status: 200 })).read.stands(ID)).toBeNull();
    expect(await reader(() => Promise.reject(new TypeError('fetch failed'))).read.stands(ID)).toBeNull();
  });
});
