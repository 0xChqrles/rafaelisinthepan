import { describe, expect, it, vi } from 'vitest';
import { GroupRegistry, parseGroupConfig } from '../config/groupConfig';
import { createLog, redactJids, type Log } from '../log';
import { commandIds, parseCommand, type OutboundCommand } from './commands';
import { memorySentStore } from './dedupStore';
import { createDispatcher } from './dispatcher';

const GROUP = '120363000000000001@g.us';
const groups = new GroupRegistry([
  parseGroupConfig('g.json', {
    id: GROUP,
    name: 'g',
    language: 'fr',
    enabled: true,
    podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
    chat: { enabled: false },
  }),
]);
const log = createLog('silent');

function podium(text = 'podium'): OutboundCommand {
  return { id: commandIds.podium(GROUP, 20700), kind: 'message', group: GROUP, text };
}

// A logger that keeps what it was given, so a test can read what would have reached
// CloudWatch.
function capturing() {
  const lines: Record<string, unknown>[] = [];
  const write = (entry: Record<string, unknown>) => void lines.push(entry);
  return { lines, log: { info: write, warn: write, error: write } as unknown as Log };
}

describe('outbound dispatcher (#236)', () => {
  it('sends once, records the WhatsApp id, and treats a replay as a duplicate', async () => {
    const send = vi.fn(async () => 'WA1');
    const sent = memorySentStore();
    const dispatcher = createDispatcher({
      sender: { send, isOpen: () => true },
      sent,
      groups,
      log,
    });
    expect(await dispatcher.dispatch(JSON.stringify(podium()))).toBe('sent');
    expect(await dispatcher.dispatch(JSON.stringify(podium()))).toBe('duplicate');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await sent.get(GROUP, podium().id))?.waMessageId).toBe('WA1');
  });

  it('defers while the socket is closed and drops what it must never send', async () => {
    const send = vi.fn(async () => 'WA1');
    const dispatcher = createDispatcher({
      sender: { send, isOpen: () => false },
      sent: memorySentStore(),
      groups,
      log,
    });
    expect(await dispatcher.dispatch(JSON.stringify(podium()))).toBe('deferred');
    expect(
      await dispatcher.dispatch(JSON.stringify({ ...podium(), group: '120363999999999999@g.us' })),
    ).toBe('dropped');
    expect(await dispatcher.dispatch('not json')).toBe('dropped');
    expect(send).not.toHaveBeenCalled();
  });

  it('logs a command id with its JIDs tagged, never in clear', async () => {
    const { lines, log: capture } = capturing();
    const dispatcher = createDispatcher({
      sender: { send: async () => 'WA1', isOpen: () => true },
      sent: memorySentStore(),
      groups,
      log: capture,
    });
    const leader: OutboundCommand = {
      id: commandIds.leader(GROUP, 20700, '33612345678@s.whatsapp.net', 3),
      kind: 'message',
      group: GROUP,
      text: 'Gab prend la tête avec 3.',
    };
    await dispatcher.dispatch(JSON.stringify(leader));
    await dispatcher.dispatch(JSON.stringify(leader));
    await dispatcher.dispatch(JSON.stringify({ ...leader, group: '120363999999999999@g.us' }));
    expect(lines).toHaveLength(3);
    expect(lines[0].command).toBe(redactJids(leader.id));
    const written = JSON.stringify(lines);
    expect(written).not.toContain('@g.us');
    expect(written).not.toContain('33612345678');
  });

  it('parses only well-formed commands', () => {
    const target = { id: 'M', participant: '33612345678@s.whatsapp.net' };
    expect(parseCommand(JSON.stringify(podium()))).toMatchObject({ kind: 'message' });
    expect(parseCommand(JSON.stringify({ ...podium(), text: '' }))).toBeNull();
    expect(
      parseCommand(JSON.stringify({ id: 'r', kind: 'reaction', group: GROUP, target, emoji: '🔥' })),
    ).toMatchObject({ kind: 'reaction' });
    expect(parseCommand(JSON.stringify({ id: 'r', kind: 'sticker', group: GROUP }))).toBeNull();
  });

  // A ref the transport cannot build a message key from must be DROPPED here: sent, it
  // throws at the socket, which reads as transient and retries the command to the
  // dead-letter queue and its alarm.
  it.each([
    ['a reaction with no author to react to', { id: 'r', kind: 'reaction', group: GROUP, emoji: '🔥', target: { id: 'M' } }],
    ['a reaction with no emoji', { id: 'r', kind: 'reaction', group: GROUP, emoji: '', target: { id: 'M', participant: 'p@s.whatsapp.net' } }],
    ['a half-formed reply ref', { id: 'x', kind: 'message', group: GROUP, text: 'hi', replyTo: { id: 'M' } }],
    ['mentions that are not strings', { id: 'x', kind: 'message', group: GROUP, text: 'hi', mentions: [7] }],
  ])('refuses %s', (_, body) => {
    expect(parseCommand(JSON.stringify(body))).toBeNull();
  });
});
