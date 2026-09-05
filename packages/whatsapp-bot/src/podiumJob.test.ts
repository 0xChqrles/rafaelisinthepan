import { describe, expect, it } from 'vitest';
import { activeDate, dayNumber } from '@whippin/shared';
import { GroupRegistry, parseGroupConfig } from './config/groupConfig';
import { memoryDeclarationStore } from './domain/declarations';
import { createLog } from './log';
import type { OutboundCommand } from './outbound/commands';
import { runPodiumJob, runReminderJob } from './podiumJob';

const GROUP = '120363000000000001@g.us';
const groups = new GroupRegistry([
  parseGroupConfig('g.json', {
    id: GROUP,
    name: 'g',
    language: 'fr',
    enabled: true,
    timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
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
    expect(await runPodiumJob({ group: GROUP, date: '2026-02-30' }, deps)).toMatchObject({
      outcome: 'skipped',
      dayNumber: 0, // no day: it must not name one it did not act on
    });
    expect(sent).toEqual([]);
  });

});

describe('the morning reminder (user-decided 2026-09-05)', () => {
  const reminding = new GroupRegistry([
    parseGroupConfig('g.json', {
      id: GROUP,
      name: 'g',
      language: 'fr',
      enabled: true,
      timezone: 'Europe/Paris', podium: { enabled: true, time: '22:30' },
      reminder: { enabled: true, time: '09:00' },
      chat: { enabled: false },
    }),
  ]);
  const day = (source: { kind?: string } | null, published = true) => ({
    get: async () => source,
    read: async () => (published ? { published, source } : { published: false, source: null }),
  });
  function deps(over: Partial<Parameters<typeof runReminderJob>[1]> = {}) {
    const sent: OutboundCommand[] = [];
    return {
      sent,
      deps: {
        groups: reminding,
        declarations: memoryDeclarationStore(),
        outbound: { enqueue: async (c: OutboundCommand) => void sent.push(c) },
        provider: null,
        log: createLog('silent'),
        now: () => new Date('2026-09-05T07:00:00Z'),
        siteOrigin: 'https://whippin.ai',
        daySource: day({ kind: 'music' }),
        ...over,
      },
    };
  }

  it('queues ONE dedup-keyed line with the kind, the podium time and the link', async () => {
    const { sent, deps: d } = deps();
    const today = dayNumber(activeDate(new Date('2026-09-05T07:00:00Z')));
    expect(await runReminderJob({ group: GROUP, kind: 'reminder' }, d)).toEqual({ outcome: 'posted', group: GROUP, dayNumber: today, lines: 0, comments: 0 });
    expect(sent[0]).toMatchObject({ id: `reminder:${GROUP}:${today}`, kind: 'message', group: GROUP });
    expect((sent[0] as { text: string }).text).toBe("Le Whippin du jour est en ligne, c'est une chanson aujourd'hui. Podium à 22h30.\nhttps://whippin.ai");
  });

  it('never invites the group to a 404: unpublished, unread, unconfigured and unwired all post nothing', async () => {
    for (const daySource of [day(null, false), { get: async () => null, read: async () => null }]) {
      const { sent, deps: d } = deps({ daySource });
      expect((await runReminderJob({ group: GROUP, kind: 'reminder' }, d)).outcome).toBe('skipped');
      expect(sent).toEqual([]);
    }
    const off = deps({ groups });
    expect((await runReminderJob({ group: GROUP, kind: 'reminder' }, off.deps)).outcome).toBe('skipped');
    const unwired = deps({ daySource: undefined });
    expect((await runReminderJob({ group: GROUP, kind: 'reminder' }, unwired.deps)).outcome).toBe('skipped');
    expect((await runReminderJob({ group: GROUP, kind: 'reminder', date: '2026-02-30' }, deps().deps)).outcome).toBe('skipped');
    // A day with a puzzle and no source still says the puzzle is up.
    const plain = deps({ daySource: day(null) });
    await runReminderJob({ group: GROUP, kind: 'reminder' }, plain.deps);
    expect((plain.sent[0] as { text: string }).text).toBe('Le Whippin du jour est en ligne. Podium à 22h30.\nhttps://whippin.ai');
  });
});
