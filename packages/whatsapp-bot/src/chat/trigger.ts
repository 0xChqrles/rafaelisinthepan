// WHEN THE BOT SPEAKS (#236, rewritten in #277). Every live message of a configured group
// reaches the model once, with the whole day in front of it; what this module decides is
// HOW it reaches it, and where the code stops the model regardless of what it decides.
//
// Two kinds of message. ADDRESSED — a mention, a reply to one of the bot's lines, or its
// name as a whole word anywhere — is always answered: the person opted in, and a limit on
// answering somebody who asked is the bot missing "when we need him". AMBIENT — the rest —
// is offered to the model, which answers, reacts, or stays out of it, under a budget the
// code holds (below). A message with nothing to answer — no words and nothing quoted, an
// emoji alone — is not offered at all.
//
// THE EXCHANGE BUDGET (user-decided 2026-09-09). It used to be a window of three messages
// after the bot's own last line, reset by every line the bot said — which is a loop with
// one person: 25 bot messages in an hour, measured, every one of them a follow-up to a
// follow-up, until the person went to bed. The limit is only ever on VOLUNTEERING: the
// bot's UNASKED answers in a row are counted (`Exchange.unasked`), a reaction counts for
// nothing (it adds no bubble), an addressed answer resets the count (they asked), a gap of
// `EXCHANGE_GAP_MS` ends the exchange, and at `MAX_UNASKED_IN_A_ROW` the bot stops
// volunteering until somebody addresses it. Set high: the longest good unasked chain in
// the log was six, the bad ones fourteen to twenty-five. The count is also told to the
// model, which is how it can raise its own bar before the code has to.

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

export type Address = 'mention' | 'reply' | 'name';
// How a message reaches the model: addressed, or ambient — offered, declinable.
export type Approach = Address | 'ambient';

export const MAX_UNASKED_IN_A_ROW = 8;
export const EXCHANGE_GAP_MS = 10 * 60_000;

export interface Exchange {
  unasked: number; // the bot's unaddressed text answers in a row
  lastSpokeAt: number | null; // ms; when the bot last answered in text
}

export const NEW_EXCHANGE: Exchange = { unasked: 0, lastSpokeAt: null };

// The exchange as it stands at `at`: over, and counted from zero, once the bot has been
// quiet for the gap.
export function currentExchange(exchange: Exchange, at: number): Exchange {
  if (exchange.lastSpokeAt === null || at - exchange.lastSpokeAt > EXCHANGE_GAP_MS) return NEW_EXCHANGE;
  return exchange;
}

// Whether an ambient message may be offered at all.
export function mayVolunteer(exchange: Exchange, at: number): boolean {
  return currentExchange(exchange, at).unasked < MAX_UNASKED_IN_A_ROW;
}

// After a TEXT answer. A reaction changes nothing here: it is how an exchange is closed,
// not continued.
export function afterAnswer(exchange: Exchange, approach: Approach, at: number): Exchange {
  const current = currentExchange(exchange, at);
  return { unasked: approach === 'ambient' ? current.unasked + 1 : 0, lastSpokeAt: at };
}

// Nothing to answer: no letter and no digit in it (an emoji, a sticker, a reaction, an
// empty caption). Not offered — a reaction to a reaction is noise.
export function isWordless(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
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

export function addressedTo(message: InboundMessage, identity: BotIdentity): Address | null {
  if (message.mentions.some((m) => namesBot(m, identity))) return 'mention';
  if (message.quoted && namesBot(message.quoted, identity)) return 'reply';
  if (namedAnywhere(identity.name).test(message.text)) return 'name';
  return null;
}

// Whether the quote under a reply is one of the bot's own lines: the quoted author is then
// spelled "you" for the model, and by name otherwise.
export function quotesBot(message: InboundMessage, identity: BotIdentity): boolean {
  return message.quoted !== undefined && namesBot(message.quoted, identity);
}

// The names a QUOTED text is rewritten with: the message's own resolved mentions, plus the
// bot under its name — a reply often quotes a line that @-mentioned the bot, and the token
// would otherwise come back as the `…last4` handle of the bot's own number.
export function namesWithBot(names: ReadonlyMap<string, string>, identity: BotIdentity): Map<string, string> {
  const all = new Map(names);
  for (const jid of identity.jids) all.set(jidUser(jid), identity.name);
  return all;
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

// EVERY mention replaced by a name, for a message on its way into the day log. The log
// reaches the provider on every later message, and a mention token spells the phone
// number (or LID) of whoever it points at — the identifier the addressed path is careful
// to resolve before the model reads it. Same rule here, same fallback: the name the group
// uses, or the `…last4` handle every other surface shows for a nameless JID, so a full
// number never travels — not even one typed by hand, since the token is matched in the
// TEXT and not in the message's mention list.
export function withMentionNames(text: string, names: ReadonlyMap<string, string>): string {
  return text
    .replace(MENTION, (_whole, digits: string) => ` ${names.get(digits) ?? fallbackName(digits)} `)
    .replace(/\s+/g, ' ')
    .trim();
}

// What is left of a message once the BOT's mention tokens and a leading name form are
// removed — the question, or nothing. With no resolution supplied, EVERY mention reads as
// addressing (a bare "@Bot @Zou" is not a question); with one, every other mention
// survives as the name the group uses, never as the number behind it.
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
    return names.size === 0 ? ' ' : ` ${names.get(digits) ?? fallbackName(digits)} `;
  });
  return text
    .replace(nameForm(identity.name, '[\\s,:;!?—-]*'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

// NOTHING TO ANSWER: no question once the addressing is gone, AND nothing quoted. A bare
// `@bot` under somebody's own question (2026-09-08, in production: a player quoted his
// question and tagged the bot, and got nothing) IS a question — the quote is what he
// asked. Only a mention with nothing behind it and nothing under it is empty.
export function nothingToAnswer(message: InboundMessage, identity: BotIdentity): boolean {
  if (message.quoted && !isWordless(message.quoted.text)) return false;
  return isWordless(questionText(message, identity));
}
