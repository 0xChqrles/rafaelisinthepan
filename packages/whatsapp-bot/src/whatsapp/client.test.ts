import type { WAUrlInfo } from 'baileys';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLog } from '../log';
import type { OutboundCommand } from '../outbound/commands';
import type { DurableAuth } from './authStore';
import { connectWhatsApp } from './client';

const GROUP = '120363000000000001@g.us';
const INVITE = 'https://whippin.ai/g/abcdefghij234567?v=20711';
const CARD: WAUrlInfo = { 'canonical-url': INVITE, 'matched-text': INVITE, title: 'Whippin AI — le_groupe' };

// The socket the client would open, and the builder it would call: no network either way.
const doubles = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  sendMessage: vi.fn(async (_jid: string, _content: Record<string, unknown>, _options?: unknown) => ({
    key: { id: 'WA1' },
  })),
  waUploadToServer: vi.fn(),
  build: vi.fn(async (_url: string, _deps: unknown): Promise<WAUrlInfo | null> => null),
}));

// PARTIAL: everything else the boundary imports from Baileys stays the library's own.
vi.mock('baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('baileys')>()),
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  makeWASocket: () => ({
    ev: { on: (name: string, handler: (payload: unknown) => void) => void doubles.handlers.set(name, handler) },
    sendMessage: doubles.sendMessage,
    waUploadToServer: doubles.waUploadToServer,
  }),
}));
vi.mock('./linkPreview', () => ({ buildLinkPreview: doubles.build }));

const auth = {
  state: { creds: {}, keys: { get: async () => ({}), set: async () => {} } },
  saveCreds: async () => {},
  drain: async () => {},
  wipe: async () => {},
} as unknown as DurableAuth;

async function connected() {
  const client = await connectWhatsApp({
    auth,
    log: createLog('silent'),
    onMessage: async () => {},
    onStop: async () => {},
  });
  doubles.handlers.get('connection.update')!({ connection: 'open' });
  return client;
}

const message = (text: string, preview?: string): OutboundCommand => ({
  id: 'reply:g:M1',
  kind: 'message',
  group: GROUP,
  text,
  ...(preview ? { preview } : {}),
});

describe('a preview card only for the link a command names (user-decided 2026-09-14)', () => {
  beforeEach(() => {
    doubles.handlers.clear();
    doubles.sendMessage.mockClear();
    doubles.build.mockReset();
  });

  // Left undefined, Baileys fetches the first https link in the text from inside the task —
  // a model's or a member's. `null` is the only value that stops it.
  it('sends `linkPreview: null`, never absent, when the command names no preview', async () => {
    const client = await connected();
    expect(await client.send(message(`regarde ${INVITE}`))).toBe('WA1');
    const [jid, content] = doubles.sendMessage.mock.calls[0];
    expect(jid).toBe(GROUP);
    expect(Object.hasOwn(content, 'linkPreview')).toBe(true);
    expect(content.linkPreview).toBeNull();
    expect(doubles.build).not.toHaveBeenCalled();
  });

  it('builds the card for exactly the link the command names, and sends it', async () => {
    doubles.build.mockResolvedValue(CARD);
    const client = await connected();
    await client.send(message(`Rejoignez le groupe : ${INVITE}`, INVITE));
    expect(doubles.build).toHaveBeenCalledTimes(1);
    expect(doubles.build.mock.calls[0][0]).toBe(INVITE);
    expect(doubles.sendMessage.mock.calls[0][1].linkPreview).toBe(CARD);
  });
});
