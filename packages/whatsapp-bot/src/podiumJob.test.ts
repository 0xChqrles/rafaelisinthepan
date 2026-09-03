import { describe, expect, it } from 'vitest';
import { activeDate, dayNumber } from '@whippin/shared';
import { GroupRegistry, parseGroupConfig } from './config/groupConfig';
import { memoryDeclarationStore } from './domain/declarations';
import { createLog } from './log';
import type { OutboundCommand } from './outbound/commands';
import { runPodiumJob } from './podiumJob';

const GROUP = '120363000000000001@g.us';
const groups = new GroupRegistry([
  parseGroupConfig('g.json', {
    id: GROUP,
    name: 'g',
    language: 'fr',
    enabled: true,
    podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
    chat: { enabled: false },
    names: { '33600000000@s.whatsapp.net': 'Zou' },
  }),
]);

describe('podium job (#236)', () => {
  it('ranks the active Whippin day, applies overrides, and queues one dedup-keyed command', async () => {
    const now = () => new Date('2026-09-03T20:00:00Z'); // 16:00 ET: still 2026-09-03
    const day = dayNumber(activeDate(now()));
    const declarations = memoryDeclarationStore();
    const base = { group: GROUP, dayNumber: day, capped: false, token: 't', messageTs: 1, receivedAt: '', lang: 'fr' };
    await declarations.record({ ...base, sender: '33612345678@s.whatsapp.net', name: 'Gab', score: 3, messageId: 'a' });
    await declarations.record({ ...base, sender: '33600000000@s.whatsapp.net', name: 'Zouzou', score: 5, messageId: 'b' });
    const sent: OutboundCommand[] = [];
    const result = await runPodiumJob(
      { group: GROUP },
      { groups, declarations, outbound: { enqueue: async (c) => void sent.push(c) }, provider: null, log: createLog('silent'), now },
    );
    expect(result).toEqual({ outcome: 'posted', group: GROUP, dayNumber: day, lines: 2, comments: 0 });
    expect(sent[0]).toMatchObject({ id: `podium:${GROUP}:${day}`, kind: 'message', group: GROUP });
    expect((sent[0] as { text: string }).text).toContain('1 — Gab — 3\n2 — Zou — 5');
  });

  it('posts nothing for an empty day or an unconfigured group; a replay names its date', async () => {
    const declarations = memoryDeclarationStore();
    const sent: OutboundCommand[] = [];
    const deps = { groups, declarations, outbound: { enqueue: async (c: OutboundCommand) => void sent.push(c) }, provider: null, log: createLog('silent') };
    expect((await runPodiumJob({ group: GROUP }, deps)).outcome).toBe('empty');
    expect((await runPodiumJob({ group: '120363999999999999@g.us' }, deps)).outcome).toBe('skipped');
    expect((await runPodiumJob({ group: GROUP, date: '2026-08-01' }, deps)).dayNumber).toBe(dayNumber('2026-08-01'));
    // A date that is not a real one is refused, not rolled over into March 2nd.
    expect((await runPodiumJob({ group: GROUP, date: '2026-02-30' }, deps)).outcome).toBe('skipped');
    expect(sent).toEqual([]);
  });
});
