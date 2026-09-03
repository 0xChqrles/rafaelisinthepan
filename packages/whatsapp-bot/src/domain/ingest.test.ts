import { describe, expect, it, vi } from 'vitest';
import { dayNumber, encodeResult } from '@whippin/shared';
import { GroupRegistry, parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import type { OutboundCommand } from '../outbound/commands';
import { memoryDeclarationStore } from './declarations';
import { createIngest } from './ingest';
import { memoryLeaderStore } from './leader';
import type { InboundMessage } from './message';

const GROUP = '120363000000000001@g.us';
const DAY = dayNumber('2026-09-03');
const ORIGIN = 'https://whippin.ai';

function registry(over: Record<string, unknown> = {}) {
  return new GroupRegistry([
    parseGroupConfig('g.json', {
      id: GROUP,
      name: 'g',
      language: 'fr',
      enabled: true,
      podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
      chat: { enabled: false },
      names: { '33600000000@s.whatsapp.net': 'Zou' },
      ...over,
    }),
  ]);
}

function token(score: number, lang = 'fr', capped = false, day = DAY): string {
  return encodeResult({
    lang,
    dayNumber: day,
    score,
    trajectory: Array.from({ length: score }, (_, i) => Math.round(((i + 1) / score) * 100)),
    solvedAt: capped ? [] : [score],
    capped,
  });
}

function message(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    group: GROUP,
    id: 'M1',
    sender: '33612345678@s.whatsapp.net',
    senderName: 'Gab',
    text: `gg ${ORIGIN}/s/${token(7)}`,
    timestamp: 1_000,
    fromMe: false,
    mentions: [],
    live: true,
    ...over,
  };
}

function harness(groups = registry()) {
  const declarations = memoryDeclarationStore();
  const sent: OutboundCommand[] = [];
  const ingest = createIngest({
    groups,
    declarations,
    outbound: { enqueue: async (c) => void sent.push(c) },
    leaders: memoryLeaderStore(),
    siteOrigin: ORIGIN,
    log: createLog('silent'),
    wait: async () => {},
  });
  return { ingest, declarations, sent };
}

describe('share ingestion (#236)', () => {
  it('records a live share under the token\'s day and reacts once', async () => {
    const { ingest, declarations, sent } = harness();
    expect(await ingest(message())).toBe('recorded');
    expect(await ingest(message())).toBe('unchanged');
    const rows = await declarations.day(GROUP, DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ score: 7, name: 'Gab', messageId: 'M1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'reaction', id: `react:${GROUP}:M1`, emoji: '👍' });
  });

  it('ignores unconfigured groups, its own messages, other languages and plain chatter', async () => {
    const { ingest, sent } = harness();
    expect(await ingest(message({ group: '120363999999999999@g.us' }))).toBe('ignored');
    expect(await ingest(message({ fromMe: true }))).toBe('ignored');
    expect(await ingest(message({ text: `${ORIGIN}/s/${token(3, 'en')}` }))).toBe('no_share');
    expect(await ingest(message({ text: 'bonjour' }))).toBe('no_share');
    expect(sent).toEqual([]);
  });

  it('a replayed share is recorded but never reacted to', async () => {
    const { ingest, sent } = harness();
    expect(await ingest(message({ live: false }))).toBe('recorded');
    expect(sent).toEqual([]);
  });

  it('reacts ONCE per message, for the best result that message carried', async () => {
    const { ingest, sent } = harness();
    const text = `${ORIGIN}/s/${token(9)} et hier ${ORIGIN}/s/${token(3, 'fr', false, DAY - 1)}`;
    expect(await ingest(message({ text }))).toBe('recorded');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'reaction', id: `react:${GROUP}:M1`, emoji: '🔥' });
  });

  it('a REPLAY moves the leader row, so a later live share cannot claim a lead it lacks', async () => {
    const { ingest, sent } = harness(registry({ leaderAnnouncements: true, reactions: false }));
    // Replayed history: recorded, and deliberately not announced…
    expect(await ingest(message({ id: 'M1', text: `${ORIGIN}/s/${token(3)}`, live: false }))).toBe(
      'recorded',
    );
    expect(sent).toEqual([]);
    // …but it counts: 5 is behind that 3 and takes no lead.
    await ingest(
      message({
        id: 'M2',
        timestamp: 1_001,
        sender: '33600000000@s.whatsapp.net',
        senderName: 'Zouzou',
        text: `${ORIGIN}/s/${token(5)}`,
      }),
    );
    expect(sent).toEqual([]);
    // A real lead over the replayed one still is.
    await ingest(
      message({
        id: 'M3',
        timestamp: 1_002,
        sender: '33600000000@s.whatsapp.net',
        senderName: 'Zouzou',
        text: `${ORIGIN}/s/${token(2)}`,
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'message', text: 'Zou prend la tête avec 2.' });
  });

  it('a later message replaces the declaration; an older replay does not', async () => {
    const { ingest, declarations } = harness();
    await ingest(message());
    await ingest(message({ id: 'M2', timestamp: 1_001, text: `${ORIGIN}/s/${token(4)}` }));
    await ingest(message({ id: 'M0', timestamp: 999, text: `${ORIGIN}/s/${token(2)}` }));
    expect((await declarations.day(GROUP, DAY))[0].score).toBe(4);
  });

  it('retries a failing write and reacts only once it succeeded', async () => {
    const declarations = memoryDeclarationStore();
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockImplementation(declarations.record);
    const sent: OutboundCommand[] = [];
    const ingest = createIngest({
      groups: registry(),
      declarations: { ...declarations, record },
      outbound: { enqueue: async (c) => void sent.push(c) },
      leaders: memoryLeaderStore(),
      siteOrigin: ORIGIN,
      log: createLog('silent'),
      wait: async () => {},
    });
    expect(await ingest(message())).toBe('recorded');
    expect(record).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);

    const dead = createIngest({
      groups: registry(),
      declarations: { ...declarations, record: vi.fn().mockRejectedValue(new Error('down')) },
      outbound: { enqueue: async (c) => void sent.push(c) },
      leaders: memoryLeaderStore(),
      siteOrigin: ORIGIN,
      log: createLog('silent'),
      wait: async () => {},
    });
    expect(await dead(message({ id: 'M9' }))).toBe('failed');
    expect(sent).toHaveLength(1);
  });

  it('a failed write for one day still records the other day in the same message', async () => {
    const declarations = memoryDeclarationStore();
    const record = vi.fn((d: Parameters<typeof declarations.record>[0]) =>
      d.dayNumber === DAY ? Promise.reject(new Error('down')) : declarations.record(d),
    );
    const sent: OutboundCommand[] = [];
    const ingest = createIngest({
      groups: registry(),
      declarations: { ...declarations, record },
      outbound: { enqueue: async (c) => void sent.push(c) },
      leaders: memoryLeaderStore(),
      siteOrigin: ORIGIN,
      log: createLog('silent'),
      wait: async () => {},
    });
    const text = `${ORIGIN}/s/${token(7)} et hier ${ORIGIN}/s/${token(5, 'fr', false, DAY - 1)}`;
    expect(await ingest(message({ text }))).toBe('failed');
    expect((await declarations.day(GROUP, DAY - 1))[0].score).toBe(5);
    expect(await declarations.day(GROUP, DAY)).toEqual([]);
  });

  it('announces a lead CHANGE, with the operator name, and never the first share', async () => {
    const { ingest, sent } = harness(registry({ leaderAnnouncements: true, reactions: false }));
    await ingest(message({ id: 'M1', text: `${ORIGIN}/s/${token(7)}` }));
    expect(sent).toEqual([]);
    await ingest(
      message({
        id: 'M2',
        timestamp: 1_001,
        sender: '33600000000@s.whatsapp.net',
        senderName: 'Zouzou',
        text: `${ORIGIN}/s/${token(3)}`,
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'message', text: 'Zou prend la tête avec 3.' });
    await ingest(message({ id: 'M3', timestamp: 1_002, text: `${ORIGIN}/s/${token(5)}` }));
    expect(sent).toHaveLength(1);
  });
});
