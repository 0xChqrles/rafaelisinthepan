// The bot's OWN inbound message shape (#236). Baileys types stop at `whatsapp/`; everything
// past that boundary — ingestion, triggers, the agent — consumes this.

export interface QuotedRef {
  id: string;
  participant: string; // JID of the quoted message's author
}

export interface InboundMessage {
  group: string; // group JID (the bot handles group messages only)
  id: string;
  sender: string; // canonical sender JID — the player key
  senderName: string; // pushName snapshot; may be empty
  text: string; // conversation / extended text / media caption; empty when none
  timestamp: number; // WhatsApp message timestamp, seconds
  fromMe: boolean;
  mentions: string[];
  quoted?: QuotedRef;
  // Delivered in real time (Baileys `notify`) versus replayed from history / a resync.
  // Shares are ingested either way (idempotently); reactions and conversation only for live.
  live: boolean;
}
