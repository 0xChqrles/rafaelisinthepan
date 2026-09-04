import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from './config/groupConfig';
import type { BrokenParameter, GroupsStore, StoredGroup } from './config/groupsStore';
import { run } from './groupsCli';

const raw = (id: string) => ({
  id,
  name: 'Whippin test',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true },
});

const stored = (slug: string, id: string): StoredGroup => {
  const body = raw(id);
  return { slug, json: JSON.stringify(body), config: parseGroupConfig(slug, body) };
};

const memoryStore = (groups: StoredGroup[], broken: BrokenParameter[] = []): GroupsStore => ({
  list: async () => ({ groups, broken }),
  put: async () => {},
  remove: async () => false,
});

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'whippin-groups-cli-'));

// Runs `body` with stdout captured, and returns what was said.
async function saying(body: () => Promise<unknown>): Promise<string> {
  const said: string[] = [];
  const log = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    said.push(String(chunk));
    return true;
  });
  try {
    await body();
  } finally {
    log.mockRestore();
  }
  return said.join('');
}

describe('bot:groups push (user-decided 2026-09-05)', () => {
  // The workflow: pull, change groups/local/<slug>.json in anything, push. The file the
  // deploy reads and the file the operator edits are the same file.
  const withFile = (dir: string, slug: string, body: unknown) =>
    writeFileSync(join(dir, `${slug}.json`), typeof body === 'string' ? body : JSON.stringify(body));

  it('pushes the local file to SSM, canonicalized, and rewrites the file to match', async () => {
    const dir = tempDir();
    withFile(dir, 'test', raw('120363000000000007@g.us'));
    const written: string[] = [];
    const store: GroupsStore = { ...memoryStore([]), put: async (_s, json) => void written.push(json) };
    const said = await saying(() => expect(run(['push', 'test'], store, dir)).resolves.toBe(0));
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).id).toBe('120363000000000007@g.us');
    expect(written[0]).toMatch(/^\{\n  "id"/); // pretty-printed, as stored
    expect(readFileSync(join(dir, 'test.json'), 'utf8')).toBe(written[0]); // file == SSM
    expect(said).toMatch(/next deploy/);
  });

  it('refuses a missing file, the template as it comes, and a second config for one JID — writing nothing', async () => {
    const dir = tempDir();
    const written: string[] = [];
    const store: GroupsStore = {
      ...memoryStore([stored('beta', '120363000000000009@g.us')]),
      put: async (_s, json) => void written.push(json),
    };
    await expect(run(['push', 'test'], store, dir)).rejects.toThrow(/no .*test\.json/);
    withFile(dir, 'test', readFileSync(join(__dirname, '..', 'groups', 'example.json'), 'utf8'));
    await expect(run(['push', 'test'], store, dir)).rejects.toThrow(/placeholder/);
    withFile(dir, 'test', raw('120363000000000009@g.us')); // beta's JID
    await expect(run(['push', 'test'], store, dir)).rejects.toThrow(/beta/);
    withFile(dir, 'test', '{oops');
    await expect(run(['push', 'test'], store, dir)).rejects.toThrow(/invalid JSON/);
    await expect(run(['push', 'Not A Slug'], store, dir)).rejects.toThrow(/slug/);
    expect(written).toEqual([]);
  });

  it('says "No change." for a file SSM already holds, and replaces a parameter the bot would refuse', async () => {
    const dir = tempDir();
    // SSM holds the CANONICAL form (pretty-printed); the file is the compact one.
    const held = { ...stored('test', '120363000000000007@g.us'), json: `${JSON.stringify(raw('120363000000000007@g.us'), null, 2)}\n` };
    withFile(dir, 'test', raw('120363000000000007@g.us'));
    const written: string[] = [];
    const same: GroupsStore = { ...memoryStore([held]), put: async (_s, json) => void written.push(json) };
    // Byte-different (compact), same canonical form: nothing to write.
    expect(await saying(() => run(['push', 'test'], same, dir))).toMatch(/No change/);
    expect(written).toEqual([]);
    // A broken parameter is fixed by pushing a good file over it.
    const broken: BrokenParameter[] = [{ name: 'test', json: '{oops', reason: 'test: invalid JSON in SSM' }];
    const damaged: GroupsStore = { ...memoryStore([], broken), put: async (_s, json) => void written.push(json) };
    await saying(() => expect(run(['push', 'test'], damaged, dir)).resolves.toBe(0));
    expect(written).toHaveLength(1);
  });
});

describe('bot:groups pull (#236)', () => {
  it('a full pull owns the directory: writes the set and clears stale files', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stale.json'), '{}');
    writeFileSync(join(dir, 'a.json'), 'old');
    const groups = [stored('a', '120363000000000001@g.us'), stored('b', '120363000000000002@g.us')];

    await expect(run(['pull'], memoryStore(groups), dir)).resolves.toBe(0);

    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(groups[0].json);
  });

  it('an empty full pull empties the directory rather than merging', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stale.json'), '{}');

    await expect(run(['pull'], memoryStore([]), dir)).resolves.toBe(0);

    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('a single pull owns its file: writes it and leaves the rest alone', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'other.json'), '{}');
    const groups = [stored('a', '120363000000000001@g.us')];

    await expect(run(['pull', 'a'], memoryStore(groups), dir)).resolves.toBe(0);

    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(groups[0].json);
    expect(readFileSync(join(dir, 'other.json'), 'utf8')).toBe('{}');
  });

  it('a single pull for a slug gone from SSM removes its orphan file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'gone.json'), '{}');

    await expect(run(['pull', 'gone'], memoryStore([]), dir)).resolves.toBe(0);

    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('refuses to write a snapshot while anything under the path is broken', async () => {
    const dir = tempDir();
    const groups = [stored('a', '120363000000000001@g.us')];
    const broken: BrokenParameter[] = [{ name: 'Main', json: '{}', reason: '"Main" is not a valid slug' }];
    // The deploy's own gate: `pull` is the ONE command that judges the set, so `list`,
    // `edit` and `rm` stay usable to fix what it names.
    await expect(run(['pull'], memoryStore(groups, broken), dir)).rejects.toThrow(/Main/);
    await expect(run(['pull', 'a'], memoryStore(groups, broken), dir)).rejects.toThrow(/Main/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('names the files it wrote and nothing a group is: its log is CI, public on this repository', async () => {
    const dir = tempDir();
    const groups = [stored('a', '120363000000000001@g.us')];
    const said = await saying(() => expect(run(['pull'], memoryStore(groups), dir)).resolves.toBe(0));
    expect(said).toContain('a.json');
    for (const secret of ['Whippin test', '22:00', 'Europe/Paris', '120363000000000001']) {
      expect(said).not.toContain(secret);
    }
    const single = await saying(() => expect(run(['pull', 'a'], memoryStore(groups), dir)).resolves.toBe(0));
    expect(single).toContain('a.json');
    expect(single).not.toContain('Whippin test');
  });
});

describe('bot:groups list (#236)', () => {
  it('lists a broken parameter with its way out, without stopping the listing', async () => {
    const groups = [stored('a', '120363000000000001@g.us'), stored('b', '120363000000000001@g.us')];
    const broken: BrokenParameter[] = [
      { name: 'Main', json: '{}', reason: '"Main" is not a valid slug' },
      { name: 'junk', json: '{oops', reason: 'junk: invalid JSON in SSM' },
    ];
    const said = await saying(() => expect(run(['list'], memoryStore(groups, broken))).resolves.toBe(0));
    expect(said).toContain('Whippin test'); // the usable rows, on the operator's own terminal
    expect(said).toMatch(/junk: invalid JSON[\s\S]*bot:groups push junk[\s\S]*bot:groups rm junk/);
    expect(said).toMatch(/Main[\s\S]*aws ssm delete-parameter/);
    // Two usable configs for one group: said here, since `pull` will refuse them.
    expect(said).toMatch(/b: already configured by a/);
  });
});
