// Baileys → our own message shape (#236). Every Baileys type stops here: what leaves is
// `InboundMessage` (domain/message.ts). Group messages only — the bot has nothing to do
// with a direct message — and every JID that names a PERSON (the sender, a mention) is
// canonicalised to its phone-number form where one is known, so one person is one player
// key whichever addressing mode a given message travelled under. The message KEY's own
// participant is kept as it came: it is what a reaction or a quote has to name.

import {
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
} from 'baileys';
import type { InboundMessage, Mention } from '../domain/message';

// A JID → the player key it stands for: identity on a phone-number JID, and a LID mapped to
// its phone number when the transport knows one (client.ts reads the mapping Baileys keeps
// in the auth store — a local lookup, never a network call). A LID nobody can map is its
// own key.
export type PlayerKeyResolver = (jid: string) => Promise<string>;

// Prefer the phone-number JID: `participant` when it already is one, else the `…Alt`
// field WhatsApp attaches to a LID-addressed message. Falls back to the LID itself.
export function canonicalSender(key: WAMessage['key']): string | null {
  const candidates = [key.participant, key.participantAlt].filter(
    (j): j is string => typeof j === 'string' && j !== '',
  );
  const pn = candidates.find((j) => j.endsWith('@s.whatsapp.net'));
  const chosen = pn ?? candidates[0];
  return chosen ? jidNormalizedUser(chosen) : null;
}

export function messageText(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  if (!content) return '';
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ''
  );
}

function contextInfo(message: WAMessage) {
  const content = normalizeMessageContent(message.message);
  if (!content) return undefined;
  return (
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    undefined
  );
}

function seconds(ts: WAMessage['messageTimestamp']): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  return Number(ts.toString());
}

export async function toInbound(
  message: WAMessage,
  live: boolean,
  resolve: PlayerKeyResolver,
): Promise<InboundMessage | null> {
  const key = message.key;
  const group = key.remoteJid ?? '';
  if (!isJidGroup(group) || !key.id) return null;
  const canonical = key.fromMe ? null : canonicalSender(key);
  if (!key.fromMe && !canonical) return null;
  // The `…Alt` field is the first answer; a LID-addressed message that came without one
  // (a history replay, typically) still resolves through the mapping the socket holds.
  const sender = canonical ? await resolve(canonical) : 'me';
  // Normalised (the device suffix dropped) exactly as Baileys itself normalises the
  // participant it writes into a quote's contextInfo — but NEVER canonicalised: in a
  // LID-addressed group this is the LID, and the LID is what the message key says.
  const participant = key.participant ? jidNormalizedUser(key.participant) : sender;
  const info = contextInfo(message);
  let quoted: InboundMessage['quoted'];
  if (info?.stanzaId && info.participant) {
    const participant = jidNormalizedUser(info.participant);
    quoted = { id: info.stanzaId, participant, player: await resolve(participant) };
  }
  const mentions: Mention[] = [];
  for (const raw of info?.mentionedJid ?? []) {
    const jid = jidNormalizedUser(raw);
    mentions.push({ jid, player: await resolve(jid) });
  }
  return {
    group,
    id: key.id,
    sender,
    participant,
    senderName: message.pushName ?? '',
    text: messageText(message),
    timestamp: seconds(message.messageTimestamp),
    fromMe: key.fromMe === true,
    mentions,
    ...(quoted ? { quoted } : {}),
    live,
  };
}
