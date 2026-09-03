import { describe, expect, it, vi } from 'vitest';
import { GroupRegistry, parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
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

  it('parses only well-formed commands', () => {
    expect(parseCommand(JSON.stringify(podium()))).toMatchObject({ kind: 'message' });
    expect(parseCommand(JSON.stringify({ ...podium(), text: '' }))).toBeNull();
    expect(
      parseCommand(
        JSON.stringify({ id: 'r', kind: 'reaction', group: GROUP, target: { id: 'M' }, emoji: '🔥' }),
      ),
    ).toMatchObject({ kind: 'reaction' });
    expect(parseCommand(JSON.stringify({ id: 'r', kind: 'sticker', group: GROUP }))).toBeNull();
  });
});
