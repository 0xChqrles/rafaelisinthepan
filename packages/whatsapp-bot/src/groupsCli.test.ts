import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from './config/groupConfig';
import type { GroupsStore, StoredGroup } from './config/groupsStore';
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

const memoryStore = (groups: StoredGroup[]): GroupsStore => ({
  list: async () => groups,
  get: async (slug) => groups.find((g) => g.slug === slug) ?? null,
  put: async () => {},
  remove: async () => false,
});

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'whippin-groups-cli-'));

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
});
