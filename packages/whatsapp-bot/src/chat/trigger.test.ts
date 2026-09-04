import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../domain/message';
import { EMPTY_FLOOR, FOLLOW_UP_MESSAGES, FOLLOW_UP_WINDOW_MS, addressedTo, advanceFloor, followsBot, questionText, withMentionNames } from './trigger';

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

  it('fires on the name, leading or not, and never on a longer word', () => {
    expect(addressedTo(message({ text: 'WhippinBot, ça fait combien ?' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'whippinbot t\'es là ?' }), identity)).toBe('name');
    // Mid-sentence too (user-decided 2026-09-04): a friend is addressed like this in a group.
    expect(addressedTo(message({ text: 'je crois que WhippinBot dort' }), identity)).toBe('name');
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

  it('names EVERY mention of a remembered message, so no number reaches the provider later', () => {
    // The ambient path (main.ts): the message was not for the bot, but it enters the window
    // the next question carries. "@336… tu confirmes ?" spells a phone number; what is
    // remembered is the name the group uses, or the `…last4` handle when nobody is known —
    // and a number typed by hand, absent from the mention list, gets the same treatment.
    const names = new Map([['33600000000', 'Zou']]);
    expect(withMentionNames('@33600000000 tu confirmes ?', names)).toBe('Zou tu confirmes ?');
    expect(withMentionNames('@33659018262 tu confirmes ?', names)).toBe('…8262 tu confirmes ?');
    expect(withMentionNames('gg @33600000000 et @33659018262 !', names)).toBe('gg Zou et …8262 !');
    expect(withMentionNames('rien à voir', names)).toBe('rien à voir');
  });

  it('offers the first few messages after the bot\'s own line as possible replies, for a while', () => {
    // A person answering the bot does not @-mention it. The first FOLLOW_UP_MESSAGES
    // messages inside the window are candidates — the second person reacting to the same
    // line counts too — and then the room is talking among itself.
    const said = advanceFloor(EMPTY_FLOOR, { fromMe: true, at: 1_000_000 });
    expect(followsBot(EMPTY_FLOOR, 5)).toBe(false);
    expect(followsBot(said, said.botAt! + 5_000)).toBe(true);
    expect(followsBot(said, said.botAt! + FOLLOW_UP_WINDOW_MS)).toBe(true);
    expect(followsBot(said, said.botAt! + FOLLOW_UP_WINDOW_MS + 1)).toBe(false);
    // Out of order (an offline delivery from before the bot spoke) is not a follow-up, and
    // does not count as "since" either.
    expect(followsBot(said, said.botAt! - 1)).toBe(false);
    expect(advanceFloor(said, { fromMe: false, at: said.botAt! - 1 })).toEqual(said);
    let floor = said;
    for (let i = 0; i < FOLLOW_UP_MESSAGES; i += 1) {
      expect(followsBot(floor, said.botAt! + 1_000 * (i + 1))).toBe(true);
      floor = advanceFloor(floor, { fromMe: false, at: said.botAt! + 1_000 * (i + 1) });
    }
    expect(followsBot(floor, said.botAt! + 10_000)).toBe(false);
    // The bot speaking again resets the count; an older echo of its own does not move it.
    expect(advanceFloor(floor, { fromMe: true, at: said.botAt! + 20_000 })).toEqual({ botAt: said.botAt! + 20_000, since: 0 });
    expect(advanceFloor(floor, { fromMe: true, at: said.botAt! - 20_000 })).toEqual(floor);
  });

  it('fires on the name anywhere in the message, as a whole word', () => {
    expect(addressedTo(message({ text: 'salut whippinbot, tu fais quoi' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'je crois que WhippinBot se trompe' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'ok @whippinbot' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'les whippinbottes sont là' }), identity)).toBe(null);
    // Mid-sentence the name is part of what was said; only the leading form is stripped.
    expect(questionText(message({ text: 'salut whippinbot, tu fais quoi' }), identity)).toBe('salut whippinbot, tu fais quoi');
});
});
