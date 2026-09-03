import { describe, expect, it } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { parseGroupConfig } from '../config/groupConfig';
import { memoryDeclarationStore, type Declaration } from '../domain/declarations';
import { memoryMemoryStore } from './memory';
import { HISTORY_WINDOW_DAYS, TOOL_DEFINITIONS, createToolRunner, resolvePlayer } from './tools';

const GROUP = '120363000000000001@g.us';
const TODAY = dayNumber('2026-09-03');
const GAB = '33612345678@s.whatsapp.net';
const ZOU = '33600000000@s.whatsapp.net';
const BRUNO1 = '33611111111@s.whatsapp.net';
const BRUNO2 = '33622222222@s.whatsapp.net';

const group = parseGroupConfig('g.json', {
  id: GROUP,
  name: 'g',
  language: 'fr',
  enabled: true,
  podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
  chat: { enabled: true },
  names: { [ZOU]: 'Zou' },
});

function row(sender: string, name: string, day: number, score: number, capped = false): Declaration {
  return {
    group: GROUP,
    dayNumber: day,
    sender,
    score,
    capped,
    token: 't',
    messageId: `${sender}#${day}`,
    messageTs: day,
    name,
    receivedAt: '',
    lang: 'fr',
  };
}

async function harness() {
  const declarations = memoryDeclarationStore();
  const rows = [
    row(GAB, 'Gab', TODAY - 3, 5),
    row(ZOU, 'Zouzou', TODAY - 3, 4),
    row(GAB, 'Gab', TODAY - 2, 3),
    row(ZOU, 'Zouzou', TODAY - 2, 6),
    row(GAB, 'Gab 🔥', TODAY - 1, 2),
    row(ZOU, 'Zouzou', TODAY - 1, 2),
    row(GAB, 'Gab 🔥', TODAY, 4),
    row(ZOU, 'Zouzou', TODAY, 3),
    row(BRUNO1, 'Bruno', TODAY, 9),
    row(BRUNO2, 'Bruno', TODAY, 500, true),
  ];
  for (const r of rows) await declarations.record(r);
  const memory = memoryMemoryStore();
  const tools = createToolRunner({
    group,
    today: TODAY,
    sender: GAB,
    declarations,
    memory,
    now: () => new Date('2026-09-03T12:00:00Z'),
  });
  return { tools, memory };
}

describe('Whippin tools are read-only structured answers (#236)', () => {
  it('resolves names against known players and overrides, and says when it cannot', () => {
    const players = [
      { sender: GAB, name: 'Gab 🔥', lastDay: TODAY },
      { sender: ZOU, name: 'Zouzou', lastDay: TODAY },
      { sender: BRUNO1, name: 'Bruno', lastDay: TODAY },
      { sender: BRUNO2, name: 'Bruno', lastDay: TODAY },
    ];
    expect(resolvePlayer('zou', players, group)).toMatchObject({ kind: 'one', player: { sender: ZOU } });
    expect(resolvePlayer('Gab', players, group)).toMatchObject({ kind: 'one', player: { sender: GAB } });
    expect(resolvePlayer('bruno', players, group)).toEqual({ kind: 'ambiguous', candidates: ['Bruno', 'Bruno'] });
    expect(resolvePlayer('Camille', players, group)).toMatchObject({ kind: 'unknown' });
    expect(resolvePlayer(ZOU, players, group)).toMatchObject({ kind: 'one' });
  });

  it('answers today\'s podium and a player\'s day', async () => {
    const { tools } = await harness();
    expect(await tools.run('get_today_podium', {})).toEqual({
      date: '2026-09-03',
      lines: [
        { position: 1, score: 3, names: ['Zou'] },
        { position: 2, score: 4, names: ['Gab 🔥'] },
        { position: 3, score: 9, names: ['Bruno'] },
      ],
      unfinished: ['Bruno'],
    });
    expect(await tools.run('get_player_score', { player: 'Zou', date: '2026-09-01' })).toMatchObject({
      player: 'Zou',
      played: true,
      score: 6,
      position: 2,
    });
    expect(await tools.run('get_player_score', { player: 'Bruno' })).toEqual({ ambiguous: ['Bruno', 'Bruno'] });
    expect(await tools.run('get_player_score', { player: 'Nobody' })).toMatchObject({ unknown: true });
  });

  it('computes history, head-to-head and win streaks from the rows', async () => {
    const { tools } = await harness();
    expect(await tools.run('get_player_history', { player: 'gab', days: 7 })).toMatchObject({
      daysPlayed: 4,
      best: 2,
      average: 3.5,
    });
    expect(await tools.run('get_head_to_head', { left: 'Gab', right: 'Zou', days: 7 })).toEqual({
      left: 'Gab 🔥',
      right: 'Zou',
      windowDays: 7,
      daysBothPlayed: 4,
      leftWins: 1,
      rightWins: 2,
      ties: 1,
      currentWinner: 'Zou',
      currentStreak: 1,
    });
    expect(await tools.run('get_win_streak', { player: 'Zou' })).toEqual({ player: 'Zou', streak: 2 });
    expect(await tools.run('get_group_records', { days: 30 })).toMatchObject({
      bestScore: { score: 2, date: '2026-09-02' },
      mostDaysPlayed: { days: 4 },
      playersSeen: 4,
    });
  });

  it('a tie ENDS the current run rather than skipping it', async () => {
    const declarations = memoryDeclarationStore();
    // Gab won yesterday; today they are exactly level. Nobody is "currently ahead".
    for (const r of [
      row(GAB, 'Gab', TODAY - 1, 3),
      row(ZOU, 'Zouzou', TODAY - 1, 7),
      row(GAB, 'Gab', TODAY, 5),
      row(ZOU, 'Zouzou', TODAY, 5),
    ]) {
      await declarations.record(r);
    }
    const tools = createToolRunner({
      group,
      today: TODAY,
      sender: GAB,
      declarations,
      memory: memoryMemoryStore(),
      now: () => new Date('2026-09-03T12:00:00Z'),
    });
    expect(await tools.run('get_head_to_head', { left: 'Gab', right: 'Zou' })).toMatchObject({
      leftWins: 1,
      rightWins: 0,
      ties: 1,
      currentWinner: null,
      currentStreak: 0,
    });
  });

  it('labels a mentioned JID the way the group knows it', async () => {
    const { tools } = await harness();
    expect(await tools.labelFor(ZOU)).toBe('Zou'); // operator override
    expect(await tools.labelFor(GAB)).toBe('Gab 🔥'); // latest snapshot
    expect(await tools.labelFor('33699998888@s.whatsapp.net')).toBe('…8888'); // never seen
  });

  it('ranks only the group\'s OWN language, in every read', async () => {
    const declarations = memoryDeclarationStore();
    await declarations.record(row(GAB, 'Gab', TODAY, 4));
    await declarations.record({ ...row(ZOU, 'Zouzou', TODAY, 2), lang: 'en' });
    const tools = createToolRunner({
      group,
      today: TODAY,
      sender: GAB,
      declarations,
      memory: memoryMemoryStore(),
      now: () => new Date('2026-09-03T12:00:00Z'),
    });
    expect(await tools.run('get_today_podium', {})).toMatchObject({
      lines: [{ position: 1, score: 4, names: ['Gab'] }],
    });
    // The filtered-out row is not even a player the group knows.
    expect(await tools.run('get_player_history', { player: 'Zou' })).toMatchObject({ unknown: true });
  });

  it('never promises a window wider than it reads, and takes a numeric string', async () => {
    const { tools } = await harness();
    const asked = (await tools.run('get_player_history', { player: 'gab', days: 90 })) as {
      windowDays: number;
    };
    expect(asked.windowDays).toBe(HISTORY_WINDOW_DAYS);
    const stringly = (await tools.run('get_head_to_head', {
      left: 'Gab',
      right: 'Zou',
      days: '30',
    })) as { windowDays: number };
    expect(stringly.windowDays).toBe(30);
    // And what the model is TOLD matches what it gets.
    const history = TOOL_DEFINITIONS.find((t) => t.name === 'get_player_history')!;
    const days = (history.parameters.properties as Record<string, { description: string }>).days;
    expect(days.description).toContain(`max ${HISTORY_WINDOW_DAYS}`);
  });

  it('refuses a date that is not a real one instead of answering about its neighbour', async () => {
    const { tools } = await harness();
    expect(await tools.run('get_player_score', { player: 'Gab', date: '2026-02-30' })).toEqual({
      error: 'date must be a real calendar date, YYYY-MM-DD',
    });
    expect(await tools.run('get_player_score', { player: 'Gab', date: '2026-09-01' })).toMatchObject({
      date: '2026-09-01',
    });
  });

  it('remembers a fact about the SENDER only, bounded, and refuses unknown tools', async () => {
    const { tools, memory } = await harness();
    expect(await tools.run('remember', { fact: '  Préfère qu\'on l\'appelle Gab.  ' })).toEqual({ saved: true, facts: 1 });
    expect((await memory.get(GROUP, GAB))?.facts).toEqual(["Préfère qu'on l'appelle Gab."]);
    expect(await memory.get(GROUP, ZOU)).toBeNull();
    expect(await tools.run('remember', { fact: 'x'.repeat(200) })).toMatchObject({ saved: false });
    expect(await tools.run('drop_table', {})).toEqual({ error: 'unknown tool drop_table' });
    expect(await tools.run('constructor', {})).toEqual({ error: 'unknown tool constructor' });
  });
});
