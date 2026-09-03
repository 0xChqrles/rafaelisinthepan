import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../domain/message';
import { addressedTo, questionText } from './trigger';

const identity = { jids: ['33700000000@s.whatsapp.net', '99999999999999@lid'], name: 'WhippinBot' };

function message(over: Partial<InboundMessage>): InboundMessage {
  return {
    group: 'g@g.us',
    id: 'M',
    sender: '33612345678@s.whatsapp.net',
    senderName: 'Gab',
    text: '',
    timestamp: 1,
    fromMe: false,
    mentions: [],
    live: true,
    ...over,
  };
}

describe('conversation triggers (#236)', () => {
  it('fires on a mention, whichever JID form the mention uses', () => {
    expect(addressedTo(message({ text: '@33700000000 ça va ?', mentions: ['33700000000@s.whatsapp.net'] }), identity)).toBe('mention');
    expect(addressedTo(message({ text: 'x', mentions: ['99999999999999@lid'] }), identity)).toBe('mention');
    expect(addressedTo(message({ text: 'x', mentions: ['33600000000@s.whatsapp.net'] }), identity)).toBeNull();
  });

  it('fires on a reply to the bot, not on a reply to somebody else', () => {
    expect(addressedTo(message({ quoted: { id: 'B', participant: '33700000000:12@s.whatsapp.net' } }), identity)).toBe('reply');
    expect(addressedTo(message({ quoted: { id: 'B', participant: '33600000000@s.whatsapp.net' } }), identity)).toBeNull();
  });

  it('fires on the conservative direct-name form only', () => {
    expect(addressedTo(message({ text: 'WhippinBot, ça fait combien ?' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'whippinbot t\'es là ?' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'je crois que WhippinBot dort' }), identity)).toBeNull();
    expect(addressedTo(message({ text: 'WhippinBotte' }), identity)).toBeNull();
  });

  it('matches a name ending in punctuation, and never runs on into a longer word', () => {
    const punctuated = { ...identity, name: 'WhippinBot!' };
    expect(addressedTo(message({ text: 'WhippinBot! qui mène ?' }), punctuated)).toBe('name');
    expect(questionText(message({ text: 'WhippinBot! qui mène ?' }), punctuated)).toBe('qui mène ?');
    // `\b` is ASCII-only, so it used to fire on a name continued by an accent.
    expect(addressedTo(message({ text: 'WhippinBoté es-tu là ?' }), identity)).toBeNull();
    const accented = { ...identity, name: 'Café' };
    expect(addressedTo(message({ text: 'Café, ça va ?' }), accented)).toBe('name');
    expect(addressedTo(message({ text: 'Caféine ?' }), accented)).toBeNull();
  });

  it('strips the addressing from what the model reads', () => {
    expect(questionText(message({ text: '@33700000000  ça fait combien de jours ?' }), identity)).toBe('ça fait combien de jours ?');
    expect(questionText(message({ text: 'WhippinBot: qui mène ?' }), identity)).toBe('qui mène ?');
  });
});
