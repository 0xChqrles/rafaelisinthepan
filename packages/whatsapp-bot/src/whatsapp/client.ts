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
import type { DurableAuth } from './authStore';
import { baileysLogger } from './baileysLog';
import { toInbound } from './inbound';

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
      if (options.pairingPhone && !pairingRequested && !auth.state.creds.registered && qr) {
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
          stopped = true;
          void options.onStop('logged_out');
          return;
        }
        if (status === DisconnectReason.connectionReplaced) {
          stopped = true;
          void options.onStop('replaced');
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

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      const live = type === 'notify';
      for (const raw of messages) {
        const message = toInbound(raw, live);
        if (!message) continue;
        options.onMessage(message).catch((error) =>
          log.error(
            { event: 'inbound.failed', messageId: message.id, error: (error as Error).message },
            'message handling failed',
          ),
        );
      }
    });

    // History sync (at pairing, and whatever a resync delivers) may replay shares; they are
    // ingested idempotently and never reacted to — `live` is false.
    socket.ev.on('messaging-history.set', ({ messages }) => {
      for (const raw of messages) {
        const message = toInbound(raw, false);
        if (!message) continue;
        options.onMessage(message).catch((error) =>
          log.error({ event: 'history.failed', error: (error as Error).message }, 'history handling'),
        );
      }
    });
  }

  start();

  return {
    isOpen: () => open && !stopped,
    selfJids,
    async send(command) {
      if (!sock || !open) throw new Error('WhatsApp socket is not open.');
      let sent: WAMessage | undefined;
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
        const quoted = command.replyTo
          ? ({
              key: {
                remoteJid: command.group,
                id: command.replyTo.id,
                participant: command.replyTo.participant,
                fromMe: command.replyTo.fromMe ?? false,
              },
              message: {},
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
      // that exits over it stores a session nobody can resume. A write that FAILED is
      // already reported by the handler that asked for it, above.
      await auth.drain();
    },
  };
}
