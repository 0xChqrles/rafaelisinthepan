// Baileys → our own message shape (#236). Every Baileys type stops here: what leaves is
// `InboundMessage` (domain/message.ts). Group messages only — the bot has nothing to do
// with a direct message — and the SENDER JID is canonicalised to its phone-number form
// where WhatsApp supplies one beside a LID, so one person is one key whichever addressing
// mode a given message travelled under.

import {
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
} from 'baileys';
import type { InboundMessage } from '../domain/message';

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

export function toInbound(message: WAMessage, live: boolean): InboundMessage | null {
  const key = message.key;
  const group = key.remoteJid ?? '';
  if (!isJidGroup(group) || !key.id) return null;
  const sender = key.fromMe ? null : canonicalSender(key);
  if (!key.fromMe && !sender) return null;
  const info = contextInfo(message);
  const quoted =
    info?.stanzaId && info.participant
      ? { id: info.stanzaId, participant: jidNormalizedUser(info.participant) }
      : undefined;
  return {
    group,
    id: key.id,
    sender: sender ?? 'me',
    senderName: message.pushName ?? '',
    text: messageText(message),
    timestamp: seconds(message.messageTimestamp),
    fromMe: key.fromMe === true,
    mentions: (info?.mentionedJid ?? []).map((j) => jidNormalizedUser(j)),
    ...(quoted ? { quoted } : {}),
    live,
  };
}
