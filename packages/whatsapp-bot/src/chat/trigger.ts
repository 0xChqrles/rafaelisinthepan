// Conversation is OPT-IN per message (#236): the bot reads the whole group stream (that is
// how it finds shares) but the model sees a message only when it is deliberately aimed at
// the bot — an explicit mention, a reply to one of the bot's messages, or a conservative
// direct-name form ("WhippinBot, …"). Everything else is a group of humans talking among
// themselves, which is not prompt material.

import type { InboundMessage } from '../domain/message';

export interface BotIdentity {
  jids: string[]; // the bot's own JIDs (phone-number form and LID form, when known)
  name: string; // the configured direct-name form (chat.name)
}

function user(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? jid;
}

function isBot(jid: string | undefined, identity: BotIdentity): boolean {
  if (!jid) return false;
  const u = user(jid);
  return identity.jids.some((own) => user(own) === u);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type Address = 'mention' | 'reply' | 'name' | null;

export function addressedTo(message: InboundMessage, identity: BotIdentity): Address {
  if (message.mentions.some((m) => isBot(m, identity))) return 'mention';
  if (message.quoted && isBot(message.quoted.participant, identity)) return 'reply';
  const name = new RegExp(`^\\s*@?${escapeRegExp(identity.name)}\\b`, 'i');
  if (name.test(message.text)) return 'name';
  return null;
}

// What the model reads: the mention tokens (`@33612345678`) and a leading name form
// removed, so the prompt holds the question, not the addressing.
export function questionText(message: InboundMessage, identity: BotIdentity): string {
  let text = message.text.replace(/@\d{5,}/g, ' ');
  text = text.replace(new RegExp(`^\\s*@?${escapeRegExp(identity.name)}\\b[\\s,:;!?—-]*`, 'i'), '');
  return text.replace(/\s+/g, ' ').trim();
}
