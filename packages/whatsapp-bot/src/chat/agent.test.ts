import { describe, expect, it, vi } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { parseGroupConfig } from '../config/groupConfig';
import { memoryDeclarationStore } from '../domain/declarations';
import type { InboundMessage } from '../domain/message';
import { createLog } from '../log';
import { LlmUnavailable, type LlmProvider, type LlmRequest, type LlmResponse } from '../llm/types';
import { ANSWERING, DEFAULT_REACTION, createAgent, plainReply, reactionIn } from './agent';
import { DayLog, memoryDayLogStore, type Turn } from './dayLog';
import { memoryDiaryStore } from './diary';
import { memoryLimitStore } from './limits';
import { NEW_EXCHANGE, type Approach, type Exchange } from './trigger';

const GROUP = '120363000000000001@g.us';
const TODAY = dayNumber('2026-09-03');
const NOW = new Date('2026-09-03T12:00:00Z'); // 14:00 in Paris
const identity = { jids: ['33700000000@s.whatsapp.net'], name: 'WhippinBot' };
const bot = '33700000000@s.whatsapp.net';
const m = (jid: string, player = jid) => ({ jid, player });
const group = parseGroupConfig('g.json', {
  id: GROUP,
  name: 'g',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true, prePrompt: 'On se chambre.', perGroupPerDay: 10 },
});

function message(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    group: GROUP,
    id: 'M1',
    sender: '33612345678@s.whatsapp.net',
    senderName: 'Gab',
    text,
    timestamp: NOW.getTime() / 1000,
    fromMe: false,
    participant: '33612345678@s.whatsapp.net',
    mentions: [m(bot)],
    live: true,
    ...over,
  };
}

function scripted(steps: ((request: LlmRequest) => Partial<LlmResponse> | Error)[]) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: 'fake',
    model: 'fake',
    async generate(request) {
      requests.push(request);
      const step = steps[requests.length - 1] ?? (() => ({ text: 'fin' }));
      const out = step(request);
      if (out instanceof Error) throw out;
      return { text: null, toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, ...out };
    },
  };
  return { provider, requests };
}

// The day log as main.ts fills it: the person's turn is on the record BEFORE the agent
// reads the day. The agent answers off the log, so a test says something by logging it.
async function said(dayLog: DayLog, text: string, over: Partial<Turn> = {}): Promise<void> {
  await dayLog.append({ group: GROUP, day: TODAY, at: NOW.getTime(), id: 'M1', kind: 'said', name: 'Gab', text, ...over });
}

function agentWith(provider: LlmProvider, over: Partial<Parameters<typeof createAgent>[0]> = {}) {
  return createAgent({
    provider,
    declarations: memoryDeclarationStore(),
    diary: memoryDiaryStore(),
    limits: memoryLimitStore(),
    dayLog: new DayLog(memoryDayLogStore()),
    dailyCallCeiling: 100,
    log: createLog('silent'),
    now: () => NOW,
    ...over,
  });
}

// `said` is what main.ts filed for the message being answered: the agent marks that turn
// wherever the day has put it. Most tests answer the turn `said()` logged under 'M1'.
const asked = (approach: Approach = 'mention', exchange: Exchange = NEW_EXCHANGE, said = { id: 'M1', name: 'Gab', text: '' }) => ({ approach, exchange, said });
const contents = (request: LlmRequest) => request.messages.map((x) => (x as { content: string }).content);

describe('the conversation agent (#236, #277)', () => {
  it('reads the whole day, stamped with the group\'s clock, runs the tool loop and records its reply', async () => {
    const { provider, requests } = scripted([
      () => ({ toolCalls: [{ id: 'c1', name: 'get_today_podium', arguments: '{}' }], finish: 'tool_calls' }),
      () => ({ text: '*Personne* n’a encore joué, Gab.' }),
    ]);
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'je pense au nombre 67', { id: 'M0', at: NOW.getTime() - 3_600_000 }); // an hour ago — still today
    await said(dayLog, 'WhippinBot qui mène ?');
    const answer = agentWith(provider, { dayLog });
    const out = await answer(message('@33700000000 qui mène ?'), group, identity, TODAY, asked());
    expect(out).toEqual({ kind: 'reply', text: 'Personne n’a encore joué, Gab.' });
    // The day, in order, as user turns with the time; the question is the last of them.
    expect(contents(requests[0])).toEqual(['[13:00] Gab: je pense au nombre 67', `[14:00] Gab: WhippinBot qui mène ?  ${ANSWERING}`]);
    expect(requests[0].tools?.map((t) => t.name)).toContain('get_head_to_head');
    expect(requests[0].tools?.map((t) => t.name)).not.toContain('remember');
    expect(requests[0].system).toContain('On se chambre.');
    expect(requests[0].system).toContain('2026-09-03, a jeudi'); // the weekday is GIVEN, never worked out
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    // AND RECORDS NOTHING ITSELF (PR-278 review): main.ts files the turn once the outbound
    // queue has accepted it, so a line the queue refused is never a turn the bot believes
    // it said. The log still holds only what the group said.
    expect(dayLog.today(GROUP, TODAY).every((t) => t.kind === 'said')).toBe(true);
  });

  it('A REACTION IS THE THIRD OUTCOME: allow-listed, and read back to the next call in its own form', async () => {
    const { provider, requests } = scripted([() => ({ text: 'REACT ❤️' }), () => ({ text: 'REACT 🎉' }), () => ({ text: 'de rien' })]);
    const dayLog = new DayLog(memoryDayLogStore());
    // What main.ts files once the queue has the reaction — the agent itself records nothing.
    const filed = (id: string, text: string, at: number) => dayLog.append({ group: GROUP, day: TODAY, at, id, kind: 'reacted', name: '', text });
    await said(dayLog, '[replying to you: "Sept, derrière Zou."] merci');
    const answer = agentWith(provider, { dayLog });
    expect(await answer(message('merci', { mentions: [], quoted: { id: 'B1', participant: bot, player: bot, text: 'Sept, derrière Zou.' } }), group, identity, TODAY, asked('reply'))).toEqual({ kind: 'react', emoji: '❤️' });
    expect(dayLog.today(GROUP, TODAY).every((t) => t.kind === 'said')).toBe(true);
    await filed('M1#react', '❤️', NOW.getTime() + 1);
    // An emoji off the list is the plainest one, never a broken sequence.
    await said(dayLog, 'top', { id: 'M2', at: NOW.getTime() + 1_000 });
    expect(await answer(message('top', { id: 'M2', mentions: [], timestamp: NOW.getTime() / 1000 + 1 }), group, identity, TODAY, asked('ambient', NEW_EXCHANGE, { id: 'M2', name: 'Gab', text: 'top' }))).toEqual({ kind: 'react', emoji: DEFAULT_REACTION });
    await filed('M2#react', DEFAULT_REACTION, NOW.getTime() + 1_001);
    // The next call reads both reactions back as the assistant's `REACT …` turns.
    await said(dayLog, 'WhippinBot et demain ?', { id: 'M3', at: NOW.getTime() + 2_000 });
    await answer(message('@33700000000 et demain ?', { id: 'M3', timestamp: NOW.getTime() / 1000 + 2 }), group, identity, TODAY, asked('mention', NEW_EXCHANGE, { id: 'M3', name: 'Gab', text: 'WhippinBot et demain ?' }));
    expect(requests[2].messages.map((x) => [x.role, (x as { content: string }).content])).toEqual([
      ['user', '[14:00] Gab: [replying to you: "Sept, derrière Zou."] merci'],
      ['assistant', 'REACT ❤️'],
      ['user', '[14:00] Gab: top'],
      ['assistant', 'REACT 👍'],
      ['user', `[14:00] Gab: WhippinBot et demain ?  ${ANSWERING}`],
    ]);
    // A reaction never charges the group's ceiling: it is not a bubble.
    expect(reactionIn('REACT ❤️')).toBe('❤️');
    expect(reactionIn('_react: 🔥_')).toBe('🔥');
    expect(reactionIn('REACT 🎉')).toBe(DEFAULT_REACTION);
    expect(reactionIn('REACTION time')).toBeNull();
    expect(reactionIn('merci')).toBeNull();
    expect(reactionIn(null)).toBeNull();
  });

  it('AMBIENT: silence is the default and costs nothing; a reply charges the group ceiling; the rules say so', async () => {
    const tight = parseGroupConfig('t.json', { ...JSON.parse(JSON.stringify({ id: GROUP, name: 'g', language: 'fr', enabled: true, timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' } })), chat: { enabled: true, perGroupPerDay: 2 } });
    const { provider, requests } = scripted([
      () => ({ text: 'NO_REPLY' }),
      () => ({ text: '_NO_REPLY_' }),
      () => ({ text: '**NO_REPLY**' }),
      () => ({ text: 'a' }),
      () => ({ text: 'b' }),
      () => ({ text: 'c' }),
    ]);
    const dayLog = new DayLog(memoryDayLogStore());
    const answer = agentWith(provider, { dayLog });
    for (const [i, text] of ['ok', 'lol', 'bon'].entries()) {
      await said(dayLog, text, { id: `F${i}`, at: NOW.getTime() + i });
      expect(await answer(message(text, { id: `F${i}`, mentions: [] }), tight, identity, TODAY, asked('ambient'))).toEqual({ kind: 'silent', reason: 'not_for_me' });
    }
    expect(requests[0].system).toContain('NOT addressed to you');
    expect(requests[0].system).toContain('NO_REPLY');
    expect(requests[0].system).toContain('answered 0 times without being addressed');
    // Declined: the ceiling (two) is untouched.
    for (const [i, text] of ['un', 'deux'].entries()) {
      await said(dayLog, text, { id: `A${i}`, at: NOW.getTime() + 10 + i });
      expect((await answer(message(text, { id: `A${i}`, mentions: [] }), tight, identity, TODAY, asked('ambient'))).kind).toBe('reply');
    }
    await said(dayLog, 'trois', { id: 'A2', at: NOW.getTime() + 20 });
    expect(await answer(message('trois', { id: 'A2', mentions: [] }), tight, identity, TODAY, asked('ambient'))).toEqual({ kind: 'silent', reason: 'group_limit' });
    // An addressed message is never told it might not be for the bot.
    const direct = scripted([() => ({ text: 'oui' })]);
    await said(dayLog, 'WhippinBot ?', { id: 'Q', at: NOW.getTime() + 30 });
    await agentWith(direct.provider, { dayLog })(message('@33700000000 et hier ?', { id: 'Q' }), group, identity, TODAY, asked());
    expect(direct.requests[0].system).not.toContain('NO_REPLY');
    expect(direct.requests[0].system).toContain('addressed to you (you are mentioned)');
  });

  it('tells the model how far into an exchange it is, and how much of the room it has been', async () => {
    const { provider, requests } = scripted([() => ({ text: 'NO_REPLY' })]);
    const dayLog = new DayLog(memoryDayLogStore());
    for (let i = 0; i < 6; i += 1) {
      await dayLog.append({ group: GROUP, day: TODAY, at: NOW.getTime() - 1000 + i, id: `T${i}`, kind: i % 2 ? 'bot' : 'said', name: i % 2 ? '' : 'Luc', text: `t${i}` });
    }
    await said(dayLog, 'gloups', { id: 'M1' });
    await agentWith(provider, { dayLog })(message('gloups', { mentions: [] }), group, identity, TODAY, asked('ambient', { unasked: 5, lastSpokeAt: NOW.getTime() - 1 }));
    expect(requests[0].system).toContain('already answered 5 times without being addressed');
    expect(requests[0].system).toContain('You wrote 3 of the last 7 messages');
    // Once the gap has passed the exchange is over, and the count starts again.
    const fresh = scripted([() => ({ text: 'NO_REPLY' })]);
    await agentWith(fresh.provider, { dayLog })(message('gloups', { mentions: [] }), group, identity, TODAY, asked('ambient', { unasked: 5, lastSpokeAt: NOW.getTime() - 3_600_000 }));
    expect(fresh.requests[0].system).toContain('answered 0 times');
  });

  it('NOTHING TO ANSWER costs nothing — and a bare mention quoting a question is a question (2026-09-08)', async () => {
    const { provider, requests } = scripted([() => ({ text: '14 bat 17, comme au golf.' })]);
    const limits = memoryLimitStore();
    const take = vi.spyOn(limits, 'take');
    const dayLog = new DayLog(memoryDayLogStore());
    const answer = agentWith(provider, { limits, dayLog });
    for (let i = 0; i < 3; i += 1) {
      expect(await answer(message('@33700000000', { id: `E${i}` }), group, identity, TODAY, asked())).toEqual({ kind: 'silent', reason: 'empty' });
    }
    expect(take).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    // The player quoted his own question and tagged the bot: in production that got
    // nothing. The quote IS the question.
    const own = { id: 'Q', participant: '33612345678@s.whatsapp.net', player: '33612345678@s.whatsapp.net', text: 'Pourtant 17 > 14, non ?' };
    await said(dayLog, '[replying to Gab: "Pourtant 17 > 14, non ?"] WhippinBot');
    expect(await answer(message('@33700000000', { quoted: own }), group, identity, TODAY, asked())).toEqual({ kind: 'reply', text: '14 bat 17, comme au golf.' });
    expect(contents(requests[0])).toEqual([`[14:00] Gab: [replying to Gab: "Pourtant 17 > 14, non ?"] WhippinBot  ${ANSWERING}`]);
  });

  it('NAMES the message it is answering, wherever the day has put it (PR-278 review)', async () => {
    // B arrives while the bot is writing its answer to A. It is filed on arrival and
    // answered once the section frees up, so the day reads A → B → the answer to A: told
    // "the last message", the model carried A on or declined.
    const { provider, requests } = scripted([() => ({ text: 'oui' })]);
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'WhippinBot qui mène ?', { id: 'A' });
    await said(dayLog, 'et demain ?', { id: 'B', at: NOW.getTime() + 1_000 });
    await dayLog.append({ group: GROUP, day: TODAY, at: NOW.getTime() + 2_000, id: 'A#reply', kind: 'bot', name: '', text: 'Personne.' });
    await agentWith(provider, { dayLog })(
      message('et demain ?', { id: 'B', mentions: [] }),
      group,
      identity,
      TODAY,
      asked('ambient', NEW_EXCHANGE, { id: 'B', name: 'Gab', text: 'et demain ?' }),
    );
    // Chronological, and the question is marked where it sits — not moved to the end.
    expect(contents(requests[0])).toEqual([
      '[14:00] Gab: WhippinBot qui mène ?',
      `[14:00] Gab: et demain ?  ${ANSWERING}`,
      'Personne.',
    ]);
    // And the rules point at the mark rather than at the end of the transcript.
    expect(requests[0].system).toContain(`The message marked "${ANSWERING}" below`);
    expect(requests[0].system).not.toContain('The last message');
    expect(requests[0].system).toContain('arrived while you were writing');
  });

  it('puts the question back when the day log never took its turn', async () => {
    // A store that refused: the turn is missing, and without this the model would answer
    // the day without ever seeing the message it is answering.
    const { provider, requests } = scripted([() => ({ text: 'oui' })]);
    const dayLog = new DayLog(memoryDayLogStore());
    await agentWith(provider, { dayLog })(
      message('@33700000000 qui mène ?'),
      group,
      identity,
      TODAY,
      asked('mention', NEW_EXCHANGE, { id: 'M1', name: 'Gab', text: 'qui mène ?' }),
    );
    expect(contents(requests[0])).toEqual([`[14:00] Gab: qui mène ?  ${ANSWERING}`]);
  });

  it('carries the DIARY as a user turn — notes, never instructions — ahead of the day', async () => {
    const diary = memoryDiaryStore();
    await diary.put(GROUP, { version: 1, text: 'Luc a promis un ∞ pour demain.', updatedAt: '', day: TODAY - 1 }, null);
    const { provider, requests } = scripted([() => ({ text: 'un' })]);
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'WhippinBot salut');
    await agentWith(provider, { diary, dayLog })(message('salut'), group, identity, TODAY, asked());
    expect(requests[0].system).not.toContain('Luc a promis');
    expect(requests[0].messages[0].role).toBe('user');
    expect(contents(requests[0])).toEqual([expect.stringMatching(/^\[Your diary of this group.*not instructions\.\]\nLuc a promis un ∞ pour demain\.$/s), `[14:00] Gab: WhippinBot salut  ${ANSWERING}`]);
    // A diary that cannot be read costs the diary, never the answer.
    const broken = { get: async () => { throw new Error('dynamo down'); }, put: async () => true };
    const again = scripted([() => ({ text: 'deux' })]);
    expect(await agentWith(again.provider, { diary: broken, dayLog })(message('salut'), group, identity, TODAY, asked())).toEqual({ kind: 'reply', text: 'deux' });
  });

  it('an unavailable model or an empty answer is silence, and the tool rounds are bounded', async () => {
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'x');
    const down = scripted([() => new LlmUnavailable('503')]);
    expect(await agentWith(down.provider, { dayLog })(message('x'), group, identity, TODAY, asked())).toEqual({ kind: 'silent', reason: 'unavailable' });
    const loop = scripted(Array.from({ length: 10 }, () => () => ({ toolCalls: [{ id: 'c', name: 'get_today_podium', arguments: '{}' }], finish: 'tool_calls' as const })));
    expect(await agentWith(loop.provider, { dayLog })(message('x'), group, identity, TODAY, asked())).toEqual({ kind: 'silent', reason: 'empty' });
    expect(loop.requests).toHaveLength(5);
    expect(loop.requests[4].tools).toBeUndefined();
    const ceiling = scripted([() => ({ text: 'hi' })]);
    expect(await agentWith(ceiling.provider, { dayLog, dailyCallCeiling: 0 })(message('x'), group, identity, TODAY, asked())).toEqual({ kind: 'silent', reason: 'call_ceiling' });
  });

  it('retries an answer that did not FINISH once, then stays silent rather than posting a fragment', async () => {
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'x');
    const once = scripted([() => ({ text: 'Gab, 7 ess', finish: 'length' }), () => ({ text: 'Sept, correct.' })]);
    expect(await agentWith(once.provider, { dayLog })(message('x'), group, identity, TODAY, asked())).toEqual({ kind: 'reply', text: 'Sept, correct.' });
    expect(once.requests).toHaveLength(2);
    const twice = scripted([() => ({ text: null, finish: 'length' }), () => ({ text: 'Gab,', finish: 'other' })]);
    expect(await agentWith(twice.provider, { dayLog })(message('x'), group, identity, TODAY, asked())).toEqual({ kind: 'silent', reason: 'unfinished' });
    expect(once.requests[0].maxTokens).toBeGreaterThanOrEqual(2000);
  });

  it('bounds a reply to plain text of a sane length', () => {
    expect(plainReply('**Gros** _titre_\n\n\nligne')).toBe('Gros titre\nligne');
    const long = plainReply(`${'Phrase courte. '.repeat(80)}`)!;
    expect(long.length).toBeLessThanOrEqual(700);
    expect(long.endsWith('.')).toBe(true);
    expect(plainReply('   ')).toBeNull();
  });
});

describe('the bot knows its own schedule in this group (user-decided 2026-09-05)', () => {
  it('states the podium time and the reminder when the group has them, and says so when it does not', async () => {
    const { provider, requests } = scripted([() => ({ text: 'À 22h.' })]);
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, "le podium c'est quand ?");
    await agentWith(provider, { dayLog })(message("@33700000000 le podium c'est quand ?"), group, identity, TODAY, asked());
    expect(requests[0].system).toContain('at 22:00');
    expect(requests[0].system).toContain('podium');
    expect(requests[0].system).not.toContain('Every morning');
    const reminding = parseGroupConfig('r.json', {
      id: GROUP, name: 'g', language: 'fr', enabled: true, timezone: 'Europe/Paris',
      podium: { enabled: false, time: '22:00' }, reminder: { enabled: true, time: '08:30' }, chat: { enabled: true },
    });
    const again = scripted([() => ({ text: 'Le matin.' })]);
    await agentWith(again.provider, { dayLog })(message('@33700000000 et le rappel ?'), reminding, identity, TODAY, asked());
    expect(again.requests[0].system).toContain('no daily podium');
    expect(again.requests[0].system).toContain('Every morning at 08:30');
  });
});

describe("the day's source rides in the system prompt, never as a tool (#236)", () => {
  const source = { kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' };
  const reader = { get: async () => source, read: async () => ({ published: true, source }) };

  it('is ambient: it is there before the question is read, and costs no tool round', async () => {
    const { provider, requests } = scripted([() => ({ text: "Ça vient d'une chanson." })]);
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'ça vient d’où ?');
    const out = await agentWith(provider, { dayLog, daySource: reader })(message('@33700000000 ça vient d’où ?'), group, identity, TODAY, asked());
    expect(out).toEqual({ kind: 'reply', text: "Ça vient d'une chanson." });
    expect(requests).toHaveLength(1);
    expect(requests[0].system).toContain('kind: music');
    expect(requests[0].system).toContain('author: Bertrand Belin');
    expect(requests[0].system).toMatch(/NOT name the author or the work/);
  });

  it('drops an answer that spells the author or the work, whatever the prompt was told', async () => {
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'ça vient d’où ?');
    for (const [i, text] of ["C'est Oiseau, de Bertrand Belin.", 'bertrand BELIN, évidemment', 'BertrandBelin'].entries()) {
      const { provider } = scripted([() => ({ text })]);
      expect(await agentWith(provider, { dayLog, daySource: reader })(message('@33700000000 ça vient d’où ?', { id: `L${i}` }), group, identity, TODAY, asked())).toEqual({ kind: 'silent', reason: 'spoiler' });
    }
    const { provider } = scripted([() => ({ text: "Je sais, c'est une chanson, et je dirai pas laquelle. Pas un oiseau en vue." })]);
    expect((await agentWith(provider, { dayLog, daySource: reader })(message('@33700000000 alors ?'), group, identity, TODAY, asked())).kind).toBe('reply');
  });

  it('a reader that says nothing, or none at all, leaves the prompt with no source', async () => {
    const dayLog = new DayLog(memoryDayLogStore());
    await said(dayLog, 'ça vient d’où ?');
    const { provider, requests } = scripted([() => ({ text: 'Aucune idée.' })]);
    await agentWith(provider, { dayLog, daySource: { get: async () => null, read: async () => null } })(message('@33700000000 ça vient d’où ?'), group, identity, TODAY, asked());
    expect(requests[0].system).not.toContain("Where today's sentence comes from");
    const bare = scripted([() => ({ text: 'Salut.' })]);
    expect(await agentWith(bare.provider, { dayLog })(message('@33700000000 salut'), group, identity, TODAY, asked())).toEqual({ kind: 'reply', text: 'Salut.' });
    expect(bare.requests[0].system).not.toContain("Where today's sentence comes from");
  });
});
