import { describe, expect, it } from 'vitest';
import { GroupRegistry, parseGroupConfig } from './groupConfig';

const valid = {
  id: '120363000000000001@g.us',
  name: 'Whippin FR',
  language: 'fr',
  enabled: true,
  podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
  chat: { enabled: true, prePrompt: 'Ce groupe aime se chambrer.' },
};

describe('group configuration (#236)', () => {
  it('parses a complete file and fills the optional knobs with their defaults', () => {
    const config = parseGroupConfig('main-fr.json', valid);
    expect(config.id).toBe(valid.id);
    expect(config.language).toBe('fr');
    expect(config.podium).toEqual({ enabled: true, time: '22:00', timezone: 'Europe/Paris' });
    expect(config.chat.name).toBe('WhippinBot');
    expect(config.chat.prePrompt).toBe('Ce groupe aime se chambrer.');
    expect(config.reactions).toBe(true);
    expect(config.leaderAnnouncements).toBe(false);
    expect(config.names).toEqual({});
  });

  it.each([
    ['a non-group id', { ...valid, id: '33612345678@s.whatsapp.net' }],
    ['an unsupported language', { ...valid, language: 'de' }],
    ['a malformed podium time', { ...valid, podium: { ...valid.podium, time: '22h' } }],
    ['an unknown time zone', { ...valid, podium: { ...valid.podium, timezone: 'Mars/Olympus' } }],
    ['an unknown field', { ...valid, chatt: {} }],
    // The NESTED typos are the ones that used to pass, and they are the dangerous half:
    // these fields have defaults, so a misspelling silently un-configures the group.
    ['an unknown chat field', { ...valid, chat: { ...valid.chat, prePromt: 'On se chambre.' } }],
    ['a misspelt ceiling', { ...valid, chat: { ...valid.chat, perUserPerDya: 3 } }],
    ['an unknown podium field', { ...valid, podium: { ...valid.podium, timzone: 'Europe/Paris' } }],
    ['a non-user override key', { ...valid, names: { 'abc@g.us': 'Zou' } }],
    ['a negative ceiling', { ...valid, chat: { ...valid.chat, perUserPerDay: -1 } }],
  ])('refuses %s', (_, raw) => {
    expect(() => parseGroupConfig('x.json', raw)).toThrow(/x\.json/);
  });

  it('keeps operator name overrides keyed by JID', () => {
    const config = parseGroupConfig('x.json', {
      ...valid,
      names: { '33612345678@s.whatsapp.net': ' Zou ' },
    });
    expect(config.names).toEqual({ '33612345678@s.whatsapp.net': 'Zou' });
  });

  it('is the allow-list: a disabled group is validated but unknown to the registry', () => {
    const disabled = parseGroupConfig('off.json', { ...valid, enabled: false });
    const registry = new GroupRegistry([disabled, parseGroupConfig('on.json', valid)]);
    expect(registry.get(valid.id)?.name).toBe('Whippin FR');
    expect(registry.all()).toHaveLength(1);
    expect(registry.get('120363999999999999@g.us')).toBeUndefined();
  });

  it('refuses two files naming one group', () => {
    const a = parseGroupConfig('a.json', valid);
    expect(() => new GroupRegistry([a, a])).toThrow(/twice/);
  });
});
