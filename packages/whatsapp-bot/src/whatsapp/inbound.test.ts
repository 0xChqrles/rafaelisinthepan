import { describe, expect, it } from 'vitest';
import type { WAMessage } from 'baileys';
import { canonicalSender, toInbound } from './inbound';

const GROUP = '120363000000000001@g.us';
// The transport's LID → number mapping, as the socket would answer it.
const KNOWN: Record<string, string> = {
  '123456789012345@lid': '33612345678@s.whatsapp.net',
  '55555555555555@lid': '33700000000@s.whatsapp.net',
};
const resolve = async (jid: string) => KNOWN[jid] ?? jid;

function wa(over: Partial<WAMessage> & { key?: Partial<WAMessage['key']> }): WAMessage {
  return {
    ...over,
    key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: '33612345678@s.whatsapp.net', ...over.key },
    messageTimestamp: 1_700_000_000,
    pushName: 'Gab',
  } as WAMessage;
}

describe('Baileys stops at the inbound boundary (#236)', () => {
  it('maps a group text with a mention and a quote into our own shape', async () => {
    const inbound = await toInbound(
      wa({
        message: {
          extendedTextMessage: {
            text: '@33700000000 alors ?',
            contextInfo: {
              mentionedJid: ['33700000000@s.whatsapp.net'],
              stanzaId: 'B1',
              participant: '33700000000:3@s.whatsapp.net',
            },
          },
        },
      }),
      true,
      resolve,
    );
    expect(inbound).toEqual({
      group: GROUP,
      id: 'M1',
      sender: '33612345678@s.whatsapp.net',
      participant: '33612345678@s.whatsapp.net',
      senderName: 'Gab',
      text: '@33700000000 alors ?',
      timestamp: 1_700_000_000,
      fromMe: false,
      mentions: [{ jid: '33700000000@s.whatsapp.net', player: '33700000000@s.whatsapp.net' }],
      quoted: { id: 'B1', participant: '33700000000@s.whatsapp.net', player: '33700000000@s.whatsapp.net' },
      live: true,
    });
  });

  it('keeps the message key\'s LID as the participant while the player is the number', async () => {
    const inbound = await toInbound(
      wa({
        key: { participant: '123456789012345:7@lid', participantAlt: '33612345678:2@s.whatsapp.net' },
        message: {
          extendedTextMessage: {
            text: '@55555555555555 alors ?',
            contextInfo: { mentionedJid: ['55555555555555:2@lid'] },
          },
        },
      }),
      true,
      resolve,
    );
    expect(inbound).toMatchObject({
      sender: '33612345678@s.whatsapp.net',
      participant: '123456789012345@lid',
      // The mention keeps the digits the text spells AND the player they stand for.
      mentions: [{ jid: '55555555555555@lid', player: '33700000000@s.whatsapp.net' }],
    });
    // A quote resolves its author the same way, and keeps the JID the quote names.
    const reply = await toInbound(
      wa({
        message: {
          extendedTextMessage: {
            text: 'oui',
            contextInfo: { stanzaId: 'B2', participant: '55555555555555:4@lid' },
          },
        },
      }),
      true,
      resolve,
    );
    expect(reply?.quoted).toEqual({ id: 'B2', participant: '55555555555555@lid', player: '33700000000@s.whatsapp.net' });
    // No `…Alt` beside the LID (a history replay): the mapping still names the player.
    const replayed = await toInbound(
      wa({ key: { participant: '123456789012345@lid' }, message: { conversation: 'x' } }),
      false,
      resolve,
    );
    expect(replayed).toMatchObject({ sender: '33612345678@s.whatsapp.net', participant: '123456789012345@lid' });
    // A LID nobody can map is its own key — nothing is invented.
    const unknown = await toInbound(
      wa({ key: { participant: '777@lid' }, message: { conversation: 'x' } }),
      false,
      resolve,
    );
    expect(unknown).toMatchObject({ sender: '777@lid', participant: '777@lid' });
  });

  it('reads captions and wrapped (ephemeral) content', async () => {
    const image = await toInbound(wa({ message: { imageMessage: { caption: 'https://whippin.ai/s/x' } } }), false, resolve);
    expect(image?.text).toBe('https://whippin.ai/s/x');
    expect(image?.live).toBe(false);
    const ephemeral = await toInbound(
      wa({ message: { ephemeralMessage: { message: { conversation: 'wrapped' } } } }),
      true,
      resolve,
    );
    expect(ephemeral?.text).toBe('wrapped');
  });

  it('prefers the phone-number JID over a LID for the player key', () => {
    expect(
      canonicalSender({ participant: '123456789012345@lid', participantAlt: '33612345678:2@s.whatsapp.net' }),
    ).toBe('33612345678@s.whatsapp.net');
    expect(canonicalSender({ participant: '123456789012345@lid' })).toBe('123456789012345@lid');
    expect(canonicalSender({})).toBeNull();
  });

  it('ignores direct messages and messages without an id', async () => {
    expect(await toInbound(wa({ key: { remoteJid: '33612345678@s.whatsapp.net' } }), true, resolve)).toBeNull();
    expect(await toInbound(wa({ key: { id: undefined } }), true, resolve)).toBeNull();
    expect(await toInbound(wa({ key: { fromMe: true, participant: undefined }, message: { conversation: 'x' } }), true, resolve)).toMatchObject({ fromMe: true, sender: 'me' });
  });
});
