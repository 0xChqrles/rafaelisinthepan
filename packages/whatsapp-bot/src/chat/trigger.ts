// Conversation is OPT-IN per message (#236): the bot reads the whole group stream (that is
// how it finds shares) but the model sees a message only when it is deliberately aimed at
// the bot — an explicit mention, a reply to one of the bot's messages, or a conservative
// direct-name form ("WhippinBot, …"). Everything else is a group of humans talking among
// themselves, which is not prompt material.

import type { InboundMessage, Mention, QuotedRef } from '../domain/message';
import { fallbackName } from '../domain/names';

export interface BotIdentity {
  jids: string[]; // the bot's own JIDs (phone-number form and LID form, when known)
  name: string; // the configured direct-name form (chat.name)
}

// The digits a mention token carries: the JID's user part, without its device suffix.
export function jidUser(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? jid;
}

function isBot(jid: string | undefined, identity: BotIdentity): boolean {
  if (!jid) return false;
  const u = jidUser(jid);
  return identity.jids.some((own) => jidUser(own) === u);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// What must NOT follow the name: another letter, so "WhippinBot" does not fire on
// "WhippinBotte". `\b` said that badly — it is ASCII-only, so it fired on "WhippinBoté",
// and it is a boundary between a word and a NON-word character, so a configured name
// ending in punctuation ("WhippinBot!") could never match at all. There is nothing to
// prevent after such a name, so it gets no boundary.
const ENDS_IN_WORD = /[\p{L}\p{N}_]$/u;

function nameBoundary(name: string): string {
  return ENDS_IN_WORD.test(name) ? '(?![\\p{L}\\p{N}_])' : '';
}

function nameForm(name: string, trailing = ''): RegExp {
  return new RegExp(`^\\s*@?${escapeRegExp(name)}${nameBoundary(name)}${trailing}`, 'iu');
}

// THE NAME FIRES ANYWHERE IN THE MESSAGE (user-decided 2026-09-04), as a whole word: the
// leading form alone missed "salut whippinbot, tu fais quoi" and "je crois que WhippinBot
// s'est trompé", which are both addressed to the bot the way a person addresses a friend
// in a group. Case-insensitive, and bounded on both sides so "WhippinBotte" still does not
// fire. Only the LEADING form is stripped from the question (`questionText`): mid-sentence
// the name is part of what was said.
function namedAnywhere(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])@?${escapeRegExp(name)}${nameBoundary(name)}`, 'iu');
}

export type Address = 'mention' | 'reply' | 'name' | 'follow' | null;

// THE FLOOR: when the bot last spoke in a group, and how many messages the group has said
// since — main.ts keeps one per group off every message the group delivers, the bot's own
// sends included (WhatsApp echoes them back as `fromMe`). `at` is the message's OWN
// timestamp, so an offline delivery orders correctly.
export interface Floor {
  botAt: number | null; // ms; null until the bot has said anything
  since: number; // messages by anybody else since that line
}

export const EMPTY_FLOOR: Floor = { botAt: null, since: 0 };

export function advanceFloor(floor: Floor, message: { fromMe: boolean; at: number }): Floor {
  if (message.fromMe) return floor.botAt !== null && message.at < floor.botAt ? floor : { botAt: message.at, since: 0 };
  // A message from before the bot's line (an offline delivery, a replay) is not "since".
  if (floor.botAt !== null && message.at < floor.botAt) return floor;
  return { botAt: floor.botAt, since: floor.since + 1 };
}

export const FOLLOW_UP_WINDOW_MS = 5 * 60_000;
export const FOLLOW_UP_MESSAGES = 3;

// A message that FOLLOWS the bot's own last line, soon after it, MAY be a reply to it
// (user-decided 2026-09-04): a person answering a line does not @-mention its author, and
// a "merci" or an "et hier ?" after the bot spoke reads as one. It is offered to the model
// as TENTATIVE — the agent tells it so and asks it to decline what was clearly not for it —
// never treated as certain. Bounded: the first FOLLOW_UP_MESSAGES messages inside
// FOLLOW_UP_WINDOW_MS of the bot's line, and no more, so a lively room after a podium
// costs a few declined calls and not one per message. (It was ONE message inside two
// minutes, and that missed the second person reacting to the same line, and anybody who
// took more than two minutes to type.)
export function followsBot(floor: Floor | undefined, at: number): boolean {
  if (!floor || floor.botAt === null) return false;
  return at >= floor.botAt && at - floor.botAt <= FOLLOW_UP_WINDOW_MS && floor.since < FOLLOW_UP_MESSAGES;
}

// Either spelling of a reference may be the bot's: the JID the message carried, or the
// player key it resolved to (the bot's own LID may be unknown to `identity` while the
// mapping already knows its number). ONE predicate for a mention and a quote alike, and
// for stripping the addressing below — three readings of "is this the bot" would let a
// message count as addressed by a token the question then keeps.
function namesBot(ref: Mention | QuotedRef, identity: BotIdentity): boolean {
  const jid = 'jid' in ref ? ref.jid : ref.participant;
  return isBot(jid, identity) || isBot(ref.player, identity);
}

export function addressedTo(message: InboundMessage, identity: BotIdentity): Address {
  if (message.mentions.some((m) => namesBot(m, identity))) return 'mention';
  if (message.quoted && namesBot(message.quoted, identity)) return 'reply';
  if (namedAnywhere(identity.name).test(message.text)) return 'name';
  return null;
}

// Who else this message points at. Only the BOT's mention is addressing; everybody else's
// is part of the question ("how many days has @Zou beaten me?"), and the agent resolves
// these to the names the group uses before any of it reaches the model — by their PLAYER
// key, which is what the declarations are filed under, while the text's @token spells the
// JID the message carried.
export function mentionedOthers(message: InboundMessage, identity: BotIdentity): Mention[] {
  return message.mentions.filter((m) => !namesBot(m, identity));
}

const MENTION = /@(\d{5,})/g;

// EVERY mention replaced by a name, for a message that was NOT addressed to the bot and is
// being remembered (main.ts). The window reaches the provider on a later question, and a
// mention token spells the phone number (or LID) of whoever it points at — the identifier
// the addressed path is careful to resolve before the model reads it. Same rule here, same
// fallback: the name the group uses, or the `…last4` handle every other surface shows for
// a nameless JID, so a full number never travels — not even one typed by hand, since the
// token is matched in the TEXT and not in the message's mention list.
export function withMentionNames(text: string, names: ReadonlyMap<string, string>): string {
  return text
    .replace(MENTION, (_whole, digits: string) => ` ${names.get(digits) ?? fallbackName(digits)} `)
    .replace(/\s+/g, ' ')
    .trim();
}

// What the model reads: the BOT's mention tokens and a leading name form removed, so the
// prompt holds the question and not the addressing.
//
// EVERY OTHER MENTION SURVIVES AS A NAME. Deleting them all was the same line of code and
// it silently rewrote the question — "@Bot combien de jours que @Zou me bat ?" reached the
// model as "combien de jours que me bat ?", a sentence about nobody. What replaces one is
// the name the group uses (`names`, resolved by the agent, which is where name resolution
// lives); anything unresolved falls back to the same `…last4` handle every other surface
// shows for a nameless JID, so a full phone number never travels to the provider.
export function questionText(
  message: InboundMessage,
  identity: BotIdentity,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  // The bot's own digits: what `identity` lists, plus the spelling of any mention that
  // names the bot by its PLAYER key — the text's token spells the JID the message
  // carried, and an unlisted LID would otherwise survive into the question as a handle.
  const own = new Set(identity.jids.map(jidUser));
  for (const m of message.mentions) if (namesBot(m, identity)) own.add(jidUser(m.jid));
  const text = message.text.replace(MENTION, (whole, digits: string) => {
    if (own.has(digits)) return ' ';
    // With no resolution supplied, this is the emptiness test's reading (see the agent):
    // every mention is addressing, and what is left is the question or nothing.
    return names.size === 0 ? ' ' : ` ${names.get(digits) ?? fallbackName(digits)} `;
  });
  return text
    .replace(nameForm(identity.name, '[\\s,:;!?—-]*'), '')
    .replace(/\s+/g, ' ')
    .trim();
}
