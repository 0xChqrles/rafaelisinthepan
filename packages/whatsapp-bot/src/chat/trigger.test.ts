import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../domain/message';
import { addressedTo, questionText } from './trigger';

const identity = { jids: ['33700000000@s.whatsapp.net', '99999999999999@lid'], name: 'WhippinBot' };
const m = (jid: string, player = jid) => ({ jid, player });

function message(over: Partial<InboundMessage>): InboundMessage {
  return {
    group: 'g@g.us',
    id: 'M',
    sender: '33612345678@s.whatsapp.net',
    participant: '33612345678@s.whatsapp.net',
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
    expect(addressedTo(message({ text: '@33700000000 ça va ?', mentions: [m('33700000000@s.whatsapp.net')] }), identity)).toBe('mention');
    expect(addressedTo(message({ text: 'x', mentions: [m('99999999999999@lid')] }), identity)).toBe('mention');
    expect(addressedTo(message({ text: 'x', mentions: [m('33600000000@s.whatsapp.net')] }), identity)).toBeNull();
    // A LID the identity does not list, resolved by the transport to the bot's number.
    const unlisted = { ...identity, jids: ['33700000000@s.whatsapp.net'] };
    expect(addressedTo(message({ text: 'x', mentions: [m('99999999999999@lid', '33700000000@s.whatsapp.net')] }), unlisted)).toBe('mention');
  });

  it('fires on a reply to the bot, not on a reply to somebody else', () => {
    const q = (participant: string, player = participant) => ({ id: 'B', participant, player });
    expect(addressedTo(message({ quoted: q('33700000000:12@s.whatsapp.net') }), identity)).toBe('reply');
    expect(addressedTo(message({ quoted: q('33600000000@s.whatsapp.net') }), identity)).toBeNull();
    // The quote names the bot's LID, which `identity` does not list; the mapping does.
    const unlisted = { ...identity, jids: ['33700000000@s.whatsapp.net'] };
    expect(addressedTo(message({ quoted: q('99999999999999@lid', '33700000000@s.whatsapp.net') }), unlisted)).toBe('reply');
    expect(addressedTo(message({ quoted: q('99999999999999@lid') }), unlisted)).toBeNull();
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
    // The bot mentioned by a LID `identity` does not list, beside another mention: the
    // token that counted as addressing must not survive as a handle in the question.
    const unlisted = { ...identity, jids: ['33700000000@s.whatsapp.net'] };
    const lid = message({
      text: '@99999999999999 combien de jours que @33600000000 me bat ?',
      mentions: [m('99999999999999@lid', '33700000000@s.whatsapp.net'), m('33600000000@s.whatsapp.net')],
    });
    expect(questionText(lid, unlisted, new Map([['33600000000', 'Zou']]))).toBe('combien de jours que Zou me bat ?');
    expect(questionText(lid, unlisted)).toBe('combien de jours que me bat ?');
  });
});
