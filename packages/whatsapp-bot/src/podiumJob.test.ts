import { describe, expect, it } from 'vitest';
import { activeDate, dayNumber } from '@whippin/shared';
import { memoryDayLogStore, type Turn } from './chat/dayLog';
import { memoryDiaryStore } from './chat/diary';
import { GroupRegistry, parseGroupConfig } from './config/groupConfig';
import { memoryDeclarationStore } from './domain/declarations';
import { FACT_JUDGE_SYSTEM } from './llm/lineJudge';
import type { LlmProvider, LlmRequest } from './llm/types';
import { createLog } from './log';
import type { OutboundCommand } from './outbound/commands';
import { runDiaryJob, runPodiumJob, runReminderJob } from './podiumJob';

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
const chatting = new GroupRegistry([
  parseGroupConfig('g.json', {
    id: GROUP,
    name: 'g',
    language: 'fr',
    enabled: true,
    timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
    chat: { enabled: true, name: 'WhippinBot' },
  }),
]);

function scripted(answer: (request: LlmRequest) => string | Promise<string>) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: 'fake',
    model: 'fake',
    async generate(request) {
      requests.push(request);
      return { text: await answer(request), toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
    },
  };
  return { provider, requests };
}

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
    expect(await runPodiumJob({ group: GROUP, date: '2026-02-30' }, deps)).toMatchObject({ outcome: 'skipped', dayNumber: 0 });
    expect(sent).toEqual([]);
  });

  it('comments from the facts, the day\'s log and the diary (#277), and goes without them when they cannot be read', async () => {
    const now = () => new Date('2026-09-03T20:00:00Z');
    const day = dayNumber(activeDate(now()));
    const declarations = memoryDeclarationStore();
    const base = { group: GROUP, dayNumber: day, capped: false, token: 't', messageTs: 1, receivedAt: '', lang: 'fr' };
    await declarations.record({ ...base, sender: '33612345678@s.whatsapp.net', name: 'Gab', score: 3, messageId: 'a' });
    await declarations.record({ ...base, sender: '33612345678@s.whatsapp.net', name: 'Gab', score: 9, messageId: 'y', dayNumber: day - 1 });
    const dayLog = memoryDayLogStore();
    await dayLog.append({ group: GROUP, day, at: now().getTime() - 3_600_000, id: 'A', kind: 'said', name: 'Gab', text: 'je vise un 3' });
    const diary = memoryDiaryStore();
    await diary.put(GROUP, { version: 1, text: 'Gab vise toujours trop haut.', updatedAt: '', day: day - 1 }, null);
    const { provider, requests } = scripted((r) => (r.system === FACT_JUDGE_SYSTEM ? '1' : 'Tu visais un 3, et le voilà.'));
    const sent: OutboundCommand[] = [];
    const result = await runPodiumJob(
      { group: GROUP },
      { groups: chatting, declarations, outbound: { enqueue: async (c) => void sent.push(c) }, provider, log: createLog('silent'), now, dayLog, diary },
    );
    expect(result).toMatchObject({ outcome: 'posted', lines: 1, comments: 1 });
    expect((sent[0] as { text: string }).text).toContain('1 — Gab — 3\n_Tu visais un 3, et le voilà._');
    const writer = requests.find((r) => r.system !== FACT_JUDGE_SYSTEM)!;
    const content = (writer.messages[0] as { content: string }).content;
    expect(content).toContain('"score":3');
    expect(content).toContain('"habit":{"name":"Gab","daysPlayed":1');
    expect(content).toContain('Gab vise toujours trop haut.');
    expect(content).toContain('Gab: je vise un 3');
    // Stores that refuse cost the background, never the podium.
    const broken = { read: async () => { throw new Error('down'); }, append: async () => {} };
    const sad = { get: async () => { throw new Error('down'); }, put: async () => true };
    const again = await runPodiumJob(
      { group: GROUP },
      { groups: chatting, declarations, outbound: { enqueue: async () => {} }, provider, log: createLog('silent'), now, dayLog: broken, diary: sad },
    );
    expect(again).toMatchObject({ outcome: 'posted', comments: 1 });
  });
});

describe('the diary rewrite at the day flip (#277)', () => {
  const now = () => new Date('2026-09-04T02:05:00Z'); // 22:05 ET: the 4th is active, the 3rd just closed
  const closed = dayNumber('2026-09-03');
  const turn = (id: string, text: string, kind: Turn['kind'] = 'said'): Turn => ({ group: GROUP, day: closed, at: Date.parse('2026-09-03T12:00:00Z'), id, kind, name: kind === 'said' ? 'Luc' : '', text });

  it('rewrites the diary of the day that just closed, from the diary and the day log, and stores it', async () => {
    const dayLog = memoryDayLogStore();
    await dayLog.append(turn('A', 'demain je fais ∞'));
    const diary = memoryDiaryStore();
    await diary.put(GROUP, { version: 1, text: 'Bruno reste la cible.', updatedAt: '', day: closed - 1 }, null);
    const { provider, requests } = scripted(() => 'Luc a promis un ∞ pour le 4. Bruno reste la cible.');
    const deps = { groups: chatting, declarations: memoryDeclarationStore(), outbound: { enqueue: async () => {} }, provider, log: createLog('silent'), now, dayLog, diary };
    expect(await runDiaryJob({ group: GROUP, kind: 'diary' }, deps)).toEqual({ outcome: 'posted', group: GROUP, dayNumber: closed, lines: 1, comments: 1 });
    expect((await diary.get(GROUP))?.text).toBe('Luc a promis un ∞ pour le 4. Bruno reste la cible.');
    expect((await diary.get(GROUP))?.day).toBe(closed);
    const content = (requests[0].messages[0] as { content: string }).content;
    expect(content).toContain('Bruno reste la cible.');
    expect(content).toContain('[Today, 2026-09-03]');
    expect(content).toContain('Luc: demain je fais ∞');
    // A replay names its day.
    await dayLog.append({ ...turn('B', 'hier'), day: closed - 1 });
    expect((await runDiaryJob({ group: GROUP, kind: 'diary', date: '2026-09-02' }, deps)).dayNumber).toBe(closed - 1);
  });

  it('FOLDS A DAY ONCE: a retried schedule, or a replay of a day already in it, changes nothing', async () => {
    const dayLog = memoryDayLogStore();
    await dayLog.append(turn('A', 'demain je fais ∞'));
    const diary = memoryDiaryStore();
    const { provider, requests } = scripted(() => 'Luc a promis un ∞.');
    const deps = { groups: chatting, declarations: memoryDeclarationStore(), outbound: { enqueue: async () => {} }, provider, log: createLog('silent'), now, dayLog, diary };
    expect((await runDiaryJob({ group: GROUP, kind: 'diary' }, deps)).outcome).toBe('posted');
    expect(requests).toHaveLength(1);
    // The scheduler's own retry: the day is already in the diary.
    expect((await runDiaryJob({ group: GROUP, kind: 'diary' }, deps)).outcome).toBe('skipped');
    // And a replay of an OLDER day must not replace a diary that has seen newer ones.
    expect((await runDiaryJob({ group: GROUP, kind: 'diary', date: '2026-09-01' }, deps)).outcome).toBe('skipped');
    expect(requests).toHaveLength(1);
    expect((await diary.get(GROUP))?.day).toBe(closed);
  });

  it('WRITES ONLY OVER THE DIARY IT READ: one that moved during the rewrite stands', async () => {
    // An operator's `forget` landing inside the model call. Writing what was read would
    // put the person straight back.
    const dayLog = memoryDayLogStore();
    await dayLog.append(turn('A', 'salut'));
    const diary = memoryDiaryStore();
    await diary.put(GROUP, { version: 1, text: 'Luc est là.', updatedAt: 'A', day: closed - 1 }, null);
    const moving = {
      get: async () => diary.get(GROUP),
      put: async (g: string, d: Parameters<typeof diary.put>[1], expected: Parameters<typeof diary.put>[2]) => diary.put(g, d, expected),
    };
    const { provider } = scripted(async () => {
      // The forget, mid-rewrite.
      await diary.put(GROUP, { version: 1, text: 'Personne.', updatedAt: 'B', day: closed - 1 }, { day: closed - 1, updatedAt: 'A' });
      return 'Luc est toujours là.';
    });
    const result = await runDiaryJob({ group: GROUP, kind: 'diary' }, { groups: chatting, declarations: memoryDeclarationStore(), outbound: { enqueue: async () => {} }, provider, log: createLog('silent'), now, dayLog, diary: moving });
    expect(result.outcome).toBe('empty');
    expect((await diary.get(GROUP))?.text).toBe('Personne.');
  });

  it('keeps the diary as it was on an empty day, an unwired job, a group without chat, or a model that could not answer', async () => {
    const diary = memoryDiaryStore();
    await diary.put(GROUP, { version: 1, text: 'as it was', updatedAt: '', day: closed - 1 }, null);
    const { provider, requests } = scripted(() => 'never');
    const base = { groups: chatting, declarations: memoryDeclarationStore(), outbound: { enqueue: async () => {} }, provider, log: createLog('silent'), now, diary };
    expect((await runDiaryJob({ group: GROUP, kind: 'diary' }, { ...base, dayLog: memoryDayLogStore() })).outcome).toBe('empty');
    expect(requests).toHaveLength(0);
    expect((await runDiaryJob({ group: GROUP, kind: 'diary' }, { ...base })).outcome).toBe('skipped'); // no day log
    expect((await runDiaryJob({ group: GROUP, kind: 'diary' }, { ...base, groups, dayLog: memoryDayLogStore() })).outcome).toBe('skipped'); // chat off
    expect((await runDiaryJob({ group: GROUP, kind: 'diary', date: '2026-02-30' }, { ...base, dayLog: memoryDayLogStore() })).outcome).toBe('skipped');
    const dayLog = memoryDayLogStore();
    await dayLog.append(turn('A', 'salut'));
    const cut = scripted(() => '');
    expect((await runDiaryJob({ group: GROUP, kind: 'diary' }, { ...base, provider: cut.provider, dayLog })).outcome).toBe('empty');
    expect((await diary.get(GROUP))?.text).toBe('as it was');
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
    const plain = deps({ daySource: day(null) });
    await runReminderJob({ group: GROUP, kind: 'reminder' }, plain.deps);
    expect((plain.sent[0] as { text: string }).text).toBe('Le Whippin du jour est en ligne. Podium à 22h30.\nhttps://whippin.ai');
  });
});
