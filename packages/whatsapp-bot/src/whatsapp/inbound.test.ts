import { describe, expect, it } from 'vitest';
import type { WAMessage } from 'baileys';
import { canonicalSender, toInbound } from './inbound';

const GROUP = '120363000000000001@g.us';

function wa(over: Partial<WAMessage> & { key?: Partial<WAMessage['key']> }): WAMessage {
  return {
    ...over,
    key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: '33612345678@s.whatsapp.net', ...over.key },
    messageTimestamp: 1_700_000_000,
    pushName: 'Gab',
  } as WAMessage;
}

describe('Baileys stops at the inbound boundary (#236)', () => {
  it('maps a group text with a mention and a quote into our own shape', () => {
    const inbound = toInbound(
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
    );
    expect(inbound).toEqual({
      group: GROUP,
      id: 'M1',
      sender: '33612345678@s.whatsapp.net',
      senderName: 'Gab',
      text: '@33700000000 alors ?',
      timestamp: 1_700_000_000,
      fromMe: false,
      mentions: ['33700000000@s.whatsapp.net'],
      quoted: { id: 'B1', participant: '33700000000@s.whatsapp.net' },
      live: true,
    });
  });

  it('reads captions and wrapped (ephemeral) content', () => {
    const image = toInbound(wa({ message: { imageMessage: { caption: 'https://whippin.ai/s/x' } } }), false);
    expect(image?.text).toBe('https://whippin.ai/s/x');
    expect(image?.live).toBe(false);
    const ephemeral = toInbound(
      wa({ message: { ephemeralMessage: { message: { conversation: 'wrapped' } } } }),
      true,
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

  it('ignores direct messages and messages without an id', () => {
    expect(toInbound(wa({ key: { remoteJid: '33612345678@s.whatsapp.net' } }), true)).toBeNull();
    expect(toInbound(wa({ key: { id: undefined } }), true)).toBeNull();
    expect(toInbound(wa({ key: { fromMe: true, participant: undefined }, message: { conversation: 'x' } }), true)).toMatchObject({ fromMe: true, sender: 'me' });
  });
});
