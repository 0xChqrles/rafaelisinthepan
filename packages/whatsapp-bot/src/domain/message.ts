// The bot's OWN inbound message shape (#236). Baileys types stop at `whatsapp/`; everything
// past that boundary — ingestion, triggers, the agent — consumes this.
//
// ONE PERSON, TWO KINDS OF KEY. WhatsApp addresses a group message either by phone number
// or by LID, and the same person is one PLAYER whichever way a given message travelled — so
// the player key is canonicalised to the phone-number form wherever one is known. But a
// MESSAGE keeps the participant it was sent under: a reaction or a quote names the original
// message key, and a key rewritten to the canonical form names a message that never
// existed. Hence `sender` (who, as a player) beside `participant` (the message's own
// author field), and a mention carrying both spellings.

export interface QuotedRef {
  id: string;
  participant: string; // JID of the quoted message's author, as the quote names it
  player: string; // the canonical player key it resolves to (phone-number form when known)
}

export interface Mention {
  jid: string; // the JID the message carried — the digits its @token in the text spells
  player: string; // the canonical player key it resolves to (phone-number form when known)
}

export interface InboundMessage {
  group: string; // group JID (the bot handles group messages only)
  id: string;
  sender: string; // canonical sender JID — the player key
  participant: string; // the message key's author field as WhatsApp addressed it — what a reaction or a quote must name
  senderName: string; // pushName snapshot; may be empty
  text: string; // conversation / extended text / media caption; empty when none
  timestamp: number; // WhatsApp message timestamp, seconds
  fromMe: boolean;
  mentions: Mention[];
  quoted?: QuotedRef;
  // Delivered in real time (Baileys `notify`) versus replayed from history / a resync.
  // Shares are ingested either way (idempotently); reactions and conversation only for live.
  live: boolean;
}
