import { GetParametersByPathCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';
import { GroupConfigError, PLACEHOLDER_GROUP_JID, parseGroupConfig } from './groupConfig';
import {
  GROUPS_PATH,
  MAX_VALUE_BYTES,
  assertDeployable,
  assertSlug,
  parameterName,
  ssmGroupsStore,
  validateForStore,
  type StoredGroup,
} from './groupsStore';

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';

const config = (over: Record<string, unknown> = {}) => ({
  id: GROUP,
  name: 'Whippin test',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true },
  ...over,
});

const stored = (slug: string, id: string): StoredGroup => {
  const raw = config({ id });
  return { slug, json: JSON.stringify(raw), config: parseGroupConfig(slug, raw) };
};

describe('the SSM group-config store (#236)', () => {
  it('confines a slug to what can name a parameter AND a file', () => {
    expect(parameterName('test')).toBe('/whippin/bot/groups/test');
    expect(parameterName('main-fr')).toBe('/whippin/bot/groups/main-fr');
    // Anything that could climb out of the path or the snapshot directory.
    for (const bad of ['../evil', 'a/b', 'Test', 'with space', '.hidden', '', '-lead']) {
      expect(() => assertSlug(bad)).toThrow(GroupConfigError);
    }
  });

  it('refuses what the bot itself would refuse, under the same parser', () => {
    expect(() => validateForStore('test', '{oops', [])).toThrow(/invalid JSON/);
    expect(() => validateForStore('test', JSON.stringify(config({ language: 'de' })), [])).toThrow(
      /language/,
    );
    // The dangerous half: a nested typo, which HAS a default to fall back to.
    const typo = config();
    (typo.podium as Record<string, unknown>).timzone = 'Europe/Paris';
    expect(() => validateForStore('test', JSON.stringify(typo), [])).toThrow(/timzone/);
  });

  it('refuses a second config for one group, enabled or not', () => {
    const others = [stored('main', GROUP)];
    expect(() => validateForStore('test', JSON.stringify(config()), others)).toThrow(/already configured by main/);
    // Disabled changes nothing: two configs for one conversation is a mistake at any setting.
    expect(() =>
      validateForStore('test', JSON.stringify(config({ enabled: false })), others),
    ).toThrow(/already configured by main/);
    // A different group is fine, and so is REPLACING the config that already holds this id.
    expect(validateForStore('test', JSON.stringify(config({ id: OTHER })), others)).toContain(OTHER);
    expect(validateForStore('main', JSON.stringify(config()), others)).toContain(GROUP);
  });

  it('refuses the example.json placeholder JID: a new slug must paste the real one', () => {
    expect(() =>
      validateForStore('test', JSON.stringify(config({ id: PLACEHOLDER_GROUP_JID })), []),
    ).toThrow(/placeholder/);
  });

  it('refuses a config over SSM Standard, and canonicalizes what it stores', () => {
    const big = config({ chat: { enabled: true, prePrompt: 'x'.repeat(MAX_VALUE_BYTES) } });
    expect(() => validateForStore('test', JSON.stringify(big), [])).toThrow(/over SSM Standard/);
    // What is stored is pretty-printed, so the next edit opens something readable.
    const text = validateForStore('test', JSON.stringify(config()), []);
    expect(text).toMatch(/^\{\n  "id"/);
    expect(text.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_VALUE_BYTES);
  });
});

// An SSM client that answers the one read the store issues, in one page.
const fakeClient = (parameters: { Name: string; Value: string }[]): SSMClient =>
  ({
    send: async (command: unknown) => {
      expect(command).toBeInstanceOf(GetParametersByPathCommand);
      return { Parameters: parameters };
    },
  }) as unknown as SSMClient;

describe('reading the path (#236)', () => {
  it('reports a broken parameter beside the usable ones rather than refusing the whole read', async () => {
    const store = ssmGroupsStore(
      fakeClient([
        { Name: `${GROUPS_PATH}/typo`, Value: JSON.stringify(config({ id: OTHER, language: 'de' })) },
        { Name: `${GROUPS_PATH}/main`, Value: JSON.stringify(config()) },
        // Made by hand in the console: a name that is no slug, so no filename.
        { Name: `${GROUPS_PATH}/Main`, Value: JSON.stringify(config({ id: OTHER })) },
        { Name: `${GROUPS_PATH}/junk`, Value: '{oops' },
      ]),
    );
    const { groups, broken } = await store.list();
    // One bad parameter used to throw here, which is the read behind `edit` and `rm` —
    // the two commands that fix it — so the operator was locked out of every command at once.
    expect(groups.map((g) => g.slug)).toEqual(['main']);
    expect(broken.map((b) => b.name)).toEqual(['Main', 'junk', 'typo']);
    const reason = (name: string) => broken.find((b) => b.name === name)?.reason;
    expect(reason('Main')).toMatch(/not a valid slug/);
    expect(reason('junk')).toMatch(/invalid JSON/);
    expect(reason('typo')).toMatch(/language/);
    // The body travels with it: `edit` opens it as it is.
    expect(broken.find((b) => b.name === 'junk')?.json).toBe('{oops');
  });

  it('refuses a snapshot while anything under the path is broken, or two configs name one group', () => {
    expect(() =>
      assertDeployable({ groups: [], broken: [{ name: 'junk', json: '{oops', reason: 'junk: invalid JSON' }] }),
    ).toThrow(/junk: invalid JSON/);
    expect(() => assertDeployable({ groups: [stored('a', GROUP), stored('b', GROUP)], broken: [] })).toThrow(
      /already configured by a/,
    );
    expect(() => assertDeployable({ groups: [stored('a', GROUP), stored('b', OTHER)], broken: [] })).not.toThrow();
  });
});
