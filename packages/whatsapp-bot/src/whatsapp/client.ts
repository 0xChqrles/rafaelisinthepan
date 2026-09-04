// The Baileys transport, wrapped (#236). Owns the ONE socket, its reconnect policy, and
// the two things the bot ever sends (a text, a reaction). Every Baileys type stops here:
// inbound traffic leaves as `InboundMessage`, outbound arrives as `OutboundCommand`.
//
// FAILURE BOUNDARIES, as decided:
//   disconnected  → reconnect in-process with backoff (ECS replaces a dead task);
//   logged out    → STOP, mark the durable auth invalidated, never erase or re-mint it —
//                   re-pairing is an operator act;
//   replaced      → another session took over this device: also stop (the lease should
//                   make this unreachable; if it happens, two sockets is the one thing
//                   this process must not add to).

import {
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
} from 'baileys';
import type { InboundMessage } from '../domain/message';
import type { Log } from '../log';
import type { OutboundCommand } from '../outbound/commands';
import { hasPairedDevice, type DurableAuth } from './authStore';
import { baileysLogger } from './baileysLog';
import { isLive, messageSeconds, toInbound } from './inbound';

export type StopReason = 'logged_out' | 'replaced';

export interface WhatsAppClientOptions {
  auth: DurableAuth;
  log: Log;
  onMessage(message: InboundMessage): Promise<void>;
  onStop(reason: StopReason): Promise<void>;
  onQr?(qr: string): void;
  // The pairing CLI's flow: request a code once the socket is up, before registration.
  pairingPhone?: string;
  onPairingCode?(code: string): void;
}

export interface WhatsAppClient {
  isOpen(): boolean;
  // The bot's own JIDs (phone-number and LID forms) once connected.
  selfJids(): string[];
  send(command: OutboundCommand): Promise<string>;
  groups(): Promise<{ id: string; subject: string; size: number }[]>;
  close(): Promise<void>;
}

// What `getMessage` may be asked to resend. WhatsApp asks within minutes of a send, so
// this is a short retry buffer, not a transcript — and the task it lives in runs for
// weeks. Bounded by count, oldest first (a Map iterates in insertion order).
const SENT_CACHE = 200;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const GROUP_CACHE_MS = 5 * 60_000;

export async function connectWhatsApp(options: WhatsAppClientOptions): Promise<WhatsAppClient> {
  const { auth, log } = options;
  // NOT a bare pino instance: Baileys logs raw JIDs and whole protocol nodes on its own
  // warning paths, so what it is handed must be unable to print a payload (baileysLog.ts).
  const baileysLog = baileysLogger(log, process.env.BOT_BAILEYS_LOG_LEVEL ?? 'warn');
  const { version } = await fetchLatestBaileysVersion();
  const groupCache = new Map<string, { at: number; meta: GroupMetadata }>();
  const sentMessages = new Map<string, WAMessage['message']>();

  let sock: WASocket | null = null;
  let open = false;
  let stopped = false;
  let attempt = 0;
  let pairingRequested = false;

  // The player key behind a JID (inbound.ts `PlayerKeyResolver`): a LID resolves to its
  // phone number through the mapping Baileys accumulates in the auth store — from message
  // envelopes, group metadata and its own sends — which is a local read, never a network
  // round trip. A LID the mapping does not know stays a LID; the person becomes one key
  // the moment WhatsApp discloses the number, and until then nothing is invented.
  async function playerKey(jid: string): Promise<string> {
    if (!isLidUser(jid) || !sock) return jid;
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      return pn ? jidNormalizedUser(pn) : jid;
    } catch (error) {
      log.warn({ event: 'lid.resolve_failed', error: (error as Error).message }, 'LID mapping read failed');
      return jid;
    }
  }

  // A stop handler is the process's own shutdown: what it rejects with has nowhere else to
  // go, and left unhandled it kills the task before the lease is released or the auth is
  // marked — the restart loop the fail-closed states exist to prevent. Said, then the exit
  // the handler was going to perform happens anyway.
  function stop(reason: StopReason): void {
    stopped = true;
    options.onStop(reason).catch((error) => {
      log.fatal({ event: 'wa.stop_failed', reason, error: (error as Error).message }, 'stop handler failed');
      process.exit(1);
    });
  }

  // Sequential per batch, so the messages of one delivery reach the handler in the order
  // WhatsApp sent them; the handlers themselves still run concurrently.
  async function deliver(messages: WAMessage[], live: (raw: WAMessage) => boolean, event: string): Promise<void> {
    for (const raw of messages) {
      try {
        const message = await toInbound(raw, live(raw), playerKey);
        if (!message) continue;
        options.onMessage(message).catch((error) =>
          log.error({ event, messageId: message.id, error: (error as Error).message }, 'message handling failed'),
        );
      } catch (error) {
        // A message the mapping could not read is skipped, never the rest of its batch —
        // and never an unhandled rejection out of an event handler.
        log.error({ event, messageId: raw.key?.id, error: (error as Error).message }, 'message mapping failed');
      }
    }
  }

  const selfJids = () => {
    const me = auth.state.creds.me;
    const out: string[] = [];
    if (me?.id) out.push(jidNormalizedUser(me.id));
    if (me?.lid) out.push(jidNormalizedUser(me.lid));
    return out;
  };

  async function cachedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
    const hit = groupCache.get(jid);
    if (hit && Date.now() - hit.at < GROUP_CACHE_MS) return hit.meta;
    if (!sock) return undefined;
    try {
      const meta = await sock.groupMetadata(jid);
      groupCache.set(jid, { at: Date.now(), meta });
      return meta;
    } catch {
      return hit?.meta;
    }
  }

  function start(): void {
    if (stopped) return;
    const socket = makeWASocket({
      version,
      logger: baileysLog,
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, baileysLog),
      },
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata,
      getMessage: async (key) => sentMessages.get(key.id ?? '') ?? undefined,
    });
    sock = socket;

    socket.ev.on('creds.update', () => {
      auth.saveCreds().catch((error) =>
        log.error({ event: 'auth.save_failed', error: (error as Error).message }, 'creds not saved'),
      );
    });

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && options.onQr) options.onQr(qr);
      if (options.pairingPhone && !pairingRequested && !hasPairedDevice(auth.state.creds) && qr) {
        pairingRequested = true;
        socket
          .requestPairingCode(options.pairingPhone)
          .then((code) => options.onPairingCode?.(code))
          .catch((error) =>
            log.error({ event: 'pairing.failed', error: (error as Error).message }, 'pairing code'),
          );
      }
      if (connection === 'open') {
        open = true;
        attempt = 0;
        log.info({ event: 'wa.open', self: selfJids().length }, 'connected');
      }
      if (connection === 'close') {
        open = false;
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        log.warn({ event: 'wa.close', status }, 'disconnected');
        if (stopped) return;
        if (status === DisconnectReason.loggedOut) {
          stop('logged_out');
          return;
        }
        if (status === DisconnectReason.connectionReplaced) {
          stop('replaced');
          return;
        }
        // restartRequired (515) after pairing wants an immediate new socket; everything
        // else backs off, doubling up to a minute.
        const delay =
          status === DisconnectReason.restartRequired
            ? 0
            : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));
        attempt += 1;
        setTimeout(start, delay);
      }
    });

    // `notify` is live; `append` — WhatsApp's offline queue, delivered on reconnect — is
    // live while the message is recent (`isLive`), so the minute a deploy costs does not
    // cost the questions asked during it.
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      void deliver(messages, (raw) => isLive(type, messageSeconds(raw.messageTimestamp), Date.now() / 1000), 'inbound.failed');
    });

    // History sync (at pairing, and whatever a resync delivers) may replay shares; they are
    // ingested idempotently and never reacted to — `live` is false.
    socket.ev.on('messaging-history.set', ({ messages }) => {
      void deliver(messages, () => false, 'history.failed');
    });
  }

  start();

  return {
    isOpen: () => open && !stopped,
    selfJids,
    async send(command) {
      if (!sock || !open) throw new Error('WhatsApp socket is not open.');
      let sent: WAMessage | undefined;
      // Both keys below carry the ref's `participant` VERBATIM: it is the original message
      // key's own author field (a LID in a LID-addressed group), and Baileys passes it
      // straight through to the wire — a canonical player key there names nothing.
      if (command.kind === 'reaction') {
        sent = await sock.sendMessage(command.group, {
          react: {
            text: command.emoji,
            key: {
              remoteJid: command.group,
              id: command.target.id,
              participant: command.target.participant,
              fromMe: command.target.fromMe ?? false,
            },
          },
        });
      } else {
        // The quote bubble is drawn from `quotedMessage`, which Baileys copies from this
        // stub's content: with nothing there it encodes empty and the reply quotes a blank.
        // A TEXT STUB WHATEVER THE ORIGINAL WAS. `messageText` already flattens a media
        // caption to text, so quoting an image-with-caption embeds the caption as a plain
        // quote rather than a thumbnail. Deliberate: a faithful stub would need the
        // original's media keys, which a queue command has no business carrying, and an
        // `imageMessage` stub without them renders worse than plain text — a broken
        // attachment instead of the words the person actually wrote. The reply path never
        // reaches here with an empty one: an addressed message with no text produces no
        // question, so the agent stays silent and no reply is queued.
        const quoted = command.replyTo
          ? ({
              key: {
                remoteJid: command.group,
                id: command.replyTo.id,
                participant: command.replyTo.participant,
                fromMe: command.replyTo.fromMe ?? false,
              },
              message: { conversation: command.replyTo.text ?? '' },
            } as WAMessage)
          : undefined;
        sent = await sock.sendMessage(
          command.group,
          { text: command.text, ...(command.mentions ? { mentions: command.mentions } : {}) },
          quoted ? { quoted } : undefined,
        );
      }
      const id = sent?.key?.id;
      if (!id) throw new Error('WhatsApp returned no message id.');
      if (sent?.message) {
        sentMessages.set(id, sent.message);
        while (sentMessages.size > SENT_CACHE) {
          const oldest = sentMessages.keys().next().value;
          if (oldest === undefined) break;
          sentMessages.delete(oldest);
        }
      }
      return id;
    },
    async groups() {
      if (!sock) return [];
      const all = await sock.groupFetchAllParticipating();
      return Object.values(all).map((g) => ({ id: g.id, subject: g.subject, size: g.size ?? g.participants.length }));
    },
    async close() {
      stopped = true;
      open = false;
      try {
        await sock?.end(undefined);
      } catch {
        // already closed
      }
      // The credential writes are queued, so closing has to WAIT for them: the last
      // `creds.update` of a pairing is the one that registers the device, and a process
      // that exits over it stores a session nobody can resume. The drain REJECTS when
      // that last write failed, and the rejection is passed on: the handler above only
      // logged it, and a caller about to declare success has to hear it.
      await auth.drain();
    },
  };
}
