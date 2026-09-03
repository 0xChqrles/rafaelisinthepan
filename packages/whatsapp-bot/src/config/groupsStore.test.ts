import { describe, expect, it } from 'vitest';
import { GroupConfigError, PLACEHOLDER_GROUP_JID, parseGroupConfig } from './groupConfig';
import { MAX_VALUE_BYTES, assertSlug, parameterName, validateForStore, type StoredGroup } from './groupsStore';

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';

const config = (over: Record<string, unknown> = {}) => ({
  id: GROUP,
  name: 'Whippin test',
  language: 'fr',
  enabled: true,
  podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
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
