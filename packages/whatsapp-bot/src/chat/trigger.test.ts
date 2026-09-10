import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../domain/message';
import {
  EXCHANGE_GAP_MS,
  MAX_UNASKED_IN_A_ROW,
  NEW_EXCHANGE,
  addressedTo,
  afterAnswer,
  currentExchange,
  isWordless,
  mayVolunteer,
  nothingToAnswer,
  questionText,
  withMentionNames,
} from './trigger';

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
    const q = (participant: string, player = participant) => ({ id: 'B', participant, player, text: '' });
    expect(addressedTo(message({ quoted: q('33700000000:12@s.whatsapp.net') }), identity)).toBe('reply');
    expect(addressedTo(message({ quoted: q('33600000000@s.whatsapp.net') }), identity)).toBeNull();
    // The quote names the bot's LID, which `identity` does not list; the mapping does.
    const unlisted = { ...identity, jids: ['33700000000@s.whatsapp.net'] };
    expect(addressedTo(message({ quoted: q('99999999999999@lid', '33700000000@s.whatsapp.net') }), unlisted)).toBe('reply');
    expect(addressedTo(message({ quoted: q('99999999999999@lid') }), unlisted)).toBeNull();
  });

  it('fires on the name, leading or not, and never on a longer word', () => {
    expect(addressedTo(message({ text: 'WhippinBot, ça fait combien ?' }), identity)).toBe('name');
    expect(addressedTo(message({ text: "whippinbot t'es là ?" }), identity)).toBe('name');
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
    const unlisted = { ...identity, jids: ['33700000000@s.whatsapp.net'] };
    const lid = message({
      text: '@99999999999999 combien de jours que @33600000000 me bat ?',
      mentions: [m('99999999999999@lid', '33700000000@s.whatsapp.net'), m('33600000000@s.whatsapp.net')],
    });
    expect(questionText(lid, unlisted, new Map([['33600000000', 'Zou']]))).toBe('combien de jours que Zou me bat ?');
    expect(questionText(lid, unlisted)).toBe('combien de jours que me bat ?');
  });

  it('names EVERY mention of a remembered message, so no number reaches the provider later', () => {
    const names = new Map([['33600000000', 'Zou']]);
    expect(withMentionNames('@33600000000 tu confirmes ?', names)).toBe('Zou tu confirmes ?');
    expect(withMentionNames('@33659018262 tu confirmes ?', names)).toBe('…8262 tu confirmes ?');
    expect(withMentionNames('gg @33600000000 et @33659018262 !', names)).toBe('gg Zou et …8262 !');
    expect(withMentionNames('rien à voir', names)).toBe('rien à voir');
  });

  it('fires on the name anywhere in the message, as a whole word', () => {
    expect(addressedTo(message({ text: 'salut whippinbot, tu fais quoi' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'je crois que WhippinBot se trompe' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'ok @whippinbot' }), identity)).toBe('name');
    expect(addressedTo(message({ text: 'les whippinbottes sont là' }), identity)).toBe(null);
    expect(questionText(message({ text: 'salut whippinbot, tu fais quoi' }), identity)).toBe('salut whippinbot, tu fais quoi');
  });
});

describe('nothing to answer (#277)', () => {
  const bot = '33700000000@s.whatsapp.net';
  it('a bare mention with nothing quoted is empty; one quoting a question IS the question', () => {
    // 2026-09-08, in production: a player quoted his own question and tagged the bot, and
    // got nothing — the text was the mention alone, and the quote was never read.
    expect(nothingToAnswer(message({ text: '@33700000000', mentions: [m(bot)] }), identity)).toBe(true);
    expect(nothingToAnswer(message({ text: '@33700000000 @33699998888', mentions: [m(bot), m('33699998888@s.whatsapp.net')] }), identity)).toBe(true);
    const own = { id: 'Q', participant: '33612345678@s.whatsapp.net', player: '33612345678@s.whatsapp.net', text: 'Pourtant 17 > 14, non ?' };
    expect(nothingToAnswer(message({ text: '@33700000000', mentions: [m(bot)], quoted: own }), identity)).toBe(false);
    // A quote with no words left (a photo, a stripped share) is not a question either.
    expect(nothingToAnswer(message({ text: '@33700000000', mentions: [m(bot)], quoted: { ...own, text: '' } }), identity)).toBe(true);
    expect(nothingToAnswer(message({ text: '@33700000000 qui mène ?', mentions: [m(bot)] }), identity)).toBe(false);
  });

  it('a message with no letter and no digit is wordless: an emoji, a sticker, nothing', () => {
    expect(isWordless('')).toBe(true);
    expect(isWordless('👍')).toBe(true);
    expect(isWordless('❤️ 🔥')).toBe(true);
    expect(isWordless('ok')).toBe(false);
    expect(isWordless('14')).toBe(false);
    expect(isWordless('é')).toBe(false);
  });
});

describe('the exchange budget (#277)', () => {
  const T = 1_000_000;

  it('counts the unasked answers in a row; an addressed answer resets it; a gap ends the exchange', () => {
    let exchange = afterAnswer(NEW_EXCHANGE, 'ambient', T);
    expect(exchange).toEqual({ unasked: 1, lastSpokeAt: T });
    exchange = afterAnswer(exchange, 'ambient', T + 1_000);
    expect(exchange.unasked).toBe(2);
    // They asked: the person opted in, and the bot is answering, not volunteering.
    expect(afterAnswer(exchange, 'mention', T + 2_000)).toEqual({ unasked: 0, lastSpokeAt: T + 2_000 });
    expect(afterAnswer(exchange, 'reply', T + 2_000).unasked).toBe(0);
    expect(afterAnswer(exchange, 'name', T + 2_000).unasked).toBe(0);
    // Quiet for the gap: a new exchange, counted from zero.
    expect(currentExchange(exchange, T + 1_000 + EXCHANGE_GAP_MS)).toBe(exchange);
    expect(currentExchange(exchange, T + 1_000 + EXCHANGE_GAP_MS + 1)).toEqual(NEW_EXCHANGE);
    expect(afterAnswer(exchange, 'ambient', T + 1_000 + EXCHANGE_GAP_MS + 1)).toEqual({ unasked: 1, lastSpokeAt: T + 1_000 + EXCHANGE_GAP_MS + 1 });
  });

  it('stops volunteering at the cap, set high: the longest good chain was six, the bad ones fourteen to twenty-five', () => {
    let exchange = NEW_EXCHANGE;
    for (let i = 0; i < MAX_UNASKED_IN_A_ROW; i += 1) {
      expect(mayVolunteer(exchange, T + i)).toBe(true);
      exchange = afterAnswer(exchange, 'ambient', T + i);
    }
    expect(mayVolunteer(exchange, T + MAX_UNASKED_IN_A_ROW)).toBe(false);
    // Only VOLUNTEERING is limited: an addressed message is always answered (main.ts never
    // asks), and answering it reopens the budget.
    expect(mayVolunteer(afterAnswer(exchange, 'mention', T + 100), T + 101)).toBe(true);
    // And the gap reopens it too.
    expect(mayVolunteer(exchange, T + MAX_UNASKED_IN_A_ROW + EXCHANGE_GAP_MS + 1)).toBe(true);
    expect(MAX_UNASKED_IN_A_ROW).toBeGreaterThanOrEqual(6);
  });
});
