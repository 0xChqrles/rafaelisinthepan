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
  podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
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

// The editor's drafts live under this prefix; counting them is how a test sees whether an
// exit cleaned up after itself.
const drafts = (slug: string): number =>
  readdirSync(tmpdir()).filter((f) => f.startsWith(`whippin-group-${slug}-`)).length;

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

// $EDITOR is spawned through a shell with the file appended, so a plain command stands in
// for one without a fixture script: `true` opens and changes nothing, `cp <src>` replaces
// the draft wholesale.
function withEditor<T>(command: string, body: () => Promise<T>): Promise<T> {
  const before = { editor: process.env.EDITOR, visual: process.env.VISUAL };
  process.env.EDITOR = command;
  delete process.env.VISUAL; // VISUAL wins over EDITOR; a developer's own must not decide the test
  return body().finally(() => {
    process.env.EDITOR = before.editor;
    if (before.visual !== undefined) process.env.VISUAL = before.visual;
  });
}

describe('bot:groups edit (#236)', () => {
  it('refuses the template saved unchanged, says why, and writes nothing to SSM', async () => {
    const written: string[] = [];
    const store: GroupsStore = { ...memoryStore([]), put: async (_s, json) => void written.push(json) };
    const said: string[] = [];
    const log = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    try {
      // `true` exits 0 having touched nothing: the operator opened example.json and saved it.
      await expect(withEditor('true', () => run(['edit', 'test'], store))).resolves.toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(written).toEqual([]);
    // The REASON has to be on screen: on the first round there is no earlier error to
    // refer back to, and "unchanged" alone tells a newcomer nothing.
    expect(said.join('')).toMatch(/placeholder/);
  });

  it('stores what the editor left, canonicalized', async () => {
    const dir = tempDir();
    const source = join(dir, 'edited.json');
    writeFileSync(source, JSON.stringify(raw('120363000000000007@g.us')));
    const written: string[] = [];
    const store: GroupsStore = { ...memoryStore([]), put: async (_s, json) => void written.push(json) };
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(withEditor(`cp ${source}`, () => run(['edit', 'test'], store))).resolves.toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).id).toBe('120363000000000007@g.us');
    expect(written[0]).toMatch(/^\{\n  "id"/); // pretty-printed, as stored
  });

  it('opens a parameter the bot would refuse, reason on top, so it can be fixed rather than locking out', async () => {
    const dir = tempDir();
    const source = join(dir, 'fixed.json');
    writeFileSync(source, JSON.stringify(raw('120363000000000007@g.us')));
    const written: string[] = [];
    const broken: BrokenParameter[] = [{ name: 'test', json: '{oops', reason: 'test: invalid JSON in SSM' }];
    const store: GroupsStore = { ...memoryStore([], broken), put: async (_s, json) => void written.push(json) };
    // Saved unchanged: aborts — and the reason was already on screen, since the body was
    // known to be invalid before the editor opened.
    const said = await saying(() => expect(withEditor('true', () => run(['edit', 'test'], store))).resolves.toBe(1));
    expect(said).toMatch(/invalid JSON/);
    expect(written).toEqual([]);
    // Replaced wholesale: stored.
    await saying(() => expect(withEditor(`cp ${source}`, () => run(['edit', 'test'], store))).resolves.toBe(0));
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).id).toBe('120363000000000007@g.us');
  });

  it('removes its draft on every exit but a deliberate abort, and names a signal that killed the editor', async () => {
    const store = memoryStore([]);
    const before = drafts('gone');
    // A valid save cleans up.
    const dir = tempDir();
    const source = join(dir, 'ok.json');
    writeFileSync(source, JSON.stringify(raw('120363000000000008@g.us')));
    await saying(() => expect(withEditor(`cp ${source}`, () => run(['edit', 'gone'], store))).resolves.toBe(0));
    expect(drafts('gone')).toBe(before);
    // An editor that failed cleans up too: the draft holds a JID, and $TMPDIR is not
    // where one sits indefinitely.
    await saying(() => expect(withEditor('false', () => run(['edit', 'gone'], store))).rejects.toThrow(/exited 1/));
    expect(drafts('gone')).toBe(before);
    // Killed by a signal, `status` is null; the message says what actually happened.
    // (`#` swallows the file path the CLI appends, so the shell kills itself.)
    await saying(() =>
      expect(withEditor('kill -TERM $$ #', () => run(['edit', 'gone'], store))).rejects.toThrow(/killed by SIGTERM/),
    );
    expect(drafts('gone')).toBe(before);
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
    expect(said).toMatch(/junk: invalid JSON[\s\S]*bot:groups edit junk[\s\S]*bot:groups rm junk/);
    expect(said).toMatch(/Main[\s\S]*aws ssm delete-parameter/);
    // Two usable configs for one group: said here, since `pull` will refuse them.
    expect(said).toMatch(/b: already configured by a/);
  });
});
