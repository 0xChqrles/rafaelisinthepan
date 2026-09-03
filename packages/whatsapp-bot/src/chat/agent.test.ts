import { describe, expect, it, vi } from 'vitest';
import { dayNumber } from '@whippin/shared';
import { parseGroupConfig } from '../config/groupConfig';
import { memoryDeclarationStore } from '../domain/declarations';
import type { InboundMessage } from '../domain/message';
import { createLog } from '../log';
import { LlmUnavailable, type LlmProvider, type LlmRequest, type LlmResponse } from '../llm/types';
import { createAgent, plainReply } from './agent';
import { RecentContext } from './context';
import { memoryLimitStore } from './limits';
import { memoryMemoryStore } from './memory';

const GROUP = '120363000000000001@g.us';
const TODAY = dayNumber('2026-09-03');
const identity = { jids: ['33700000000@s.whatsapp.net'], name: 'WhippinBot' };
const group = parseGroupConfig('g.json', {
  id: GROUP,
  name: 'g',
  language: 'fr',
  enabled: true,
  podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
  chat: { enabled: true, prePrompt: 'On se chambre.', perUserPerDay: 2, perGroupPerDay: 10 },
});

function message(text: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    group: GROUP,
    id: 'M1',
    sender: '33612345678@s.whatsapp.net',
    senderName: 'Gab',
    text,
    timestamp: 1,
    fromMe: false,
    mentions: ['33700000000@s.whatsapp.net'],
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
      return {
        text: null,
        toolCalls: [],
        finish: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        ...out,
      };
    },
  };
  return { provider, requests };
}

function agentWith(provider: LlmProvider, over: Partial<Parameters<typeof createAgent>[0]> = {}) {
  return createAgent({
    provider,
    declarations: memoryDeclarationStore(),
    memory: memoryMemoryStore(),
    limits: memoryLimitStore(),
    context: new RecentContext(),
    dailyCallCeiling: 100,
    log: createLog('silent'),
    now: () => new Date('2026-09-03T12:00:00Z'),
    ...over,
  });
}

describe('addressed conversation (#236)', () => {
  it('runs the tool loop and returns one plain reply, with the addressing stripped', async () => {
    const { provider, requests } = scripted([
      () => ({
        toolCalls: [{ id: 'c1', name: 'get_today_podium', arguments: '{}' }],
        finish: 'tool_calls',
      }),
      () => ({ text: '*Personne* n’a encore joué, Gab.' }),
    ]);
    const answer = agentWith(provider);
    const out = await answer(message('@33700000000 qui mène ?'), group, identity, TODAY);
    expect(out).toEqual({ kind: 'reply', text: 'Personne n’a encore joué, Gab.' });
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'Gab: qui mène ?' }]);
    expect(requests[0].tools?.map((t) => t.name)).toContain('get_head_to_head');
    expect(requests[0].system).toContain('On se chambre.');
    expect(requests[1].messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    expect(JSON.parse((requests[1].messages[2] as { content: string }).content)).toMatchObject({ lines: [] });
  });

  it('carries recent context and the sender\'s notes; stays silent on the ceilings', async () => {
    const memory = memoryMemoryStore();
    await memory.put(GROUP, '33612345678@s.whatsapp.net', {
      version: 1,
      updatedAt: '',
      facts: ['Préfère Gabounet.'],
    });
    const { provider, requests } = scripted([() => ({ text: 'un' }), () => ({ text: 'deux' })]);
    const answer = agentWith(provider, { memory });
    await answer(message('salut'), group, identity, TODAY);
    await answer(message('encore', { id: 'M2' }), group, identity, TODAY);
    // The notes are CONVERSATION, not system: what a group member said about themselves
    // must not become a standing instruction of the bot's (prompt injection).
    expect(requests[0].system).not.toContain('Préfère Gabounet.');
    expect((requests[0].messages[0] as { content: string }).content).toContain('Préfère Gabounet.');
    expect(requests[0].messages[0].role).toBe('user');
    expect(requests[1].messages.map((m) => (m as { content: string }).content)).toEqual([
      expect.stringContaining('Préfère Gabounet.'),
      'Gab: salut',
      'un',
      'Gab: encore',
    ]);
    expect(await answer(message('trois', { id: 'M3' }), group, identity, TODAY)).toEqual({
      kind: 'silent',
      reason: 'user_limit',
    });
  });

  it('a bare mention is not a question: no quota, no model call', async () => {
    const { provider, requests } = scripted([() => ({ text: 'hi' })]);
    const limits = memoryLimitStore();
    const take = vi.spyOn(limits, 'take');
    const answer = agentWith(provider, { limits });
    for (let i = 0; i < 5; i += 1) {
      expect(await answer(message('@33700000000', { id: `M${i}` }), group, identity, TODAY)).toEqual({
        kind: 'silent',
        reason: 'empty',
      });
    }
    expect(take).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    // The two-a-day ceiling was never touched, so a real question still gets an answer.
    expect(await answer(message('@33700000000 qui mène ?'), group, identity, TODAY)).toEqual({
      kind: 'reply',
      text: 'hi',
    });
  });

  it('an unavailable model or an empty answer is silence, and the tool rounds are bounded', async () => {
    const down = scripted([() => new LlmUnavailable('503')]);
    expect(await agentWith(down.provider)(message('x'), group, identity, TODAY)).toEqual({
      kind: 'silent',
      reason: 'unavailable',
    });
    const loop = scripted(
      Array.from({ length: 10 }, () => () => ({
        toolCalls: [{ id: 'c', name: 'get_today_podium', arguments: '{}' }],
        finish: 'tool_calls' as const,
      })),
    );
    expect(await agentWith(loop.provider)(message('x'), group, identity, TODAY)).toEqual({
      kind: 'silent',
      reason: 'empty',
    });
    expect(loop.requests).toHaveLength(5);
    expect(loop.requests[4].tools).toBeUndefined();
    const ceiling = scripted([() => ({ text: 'hi' })]);
    expect(
      await agentWith(ceiling.provider, { dailyCallCeiling: 0 })(message('x'), group, identity, TODAY),
    ).toEqual({ kind: 'silent', reason: 'call_ceiling' });
  });

  it('keeps another player\'s mention in the question, as the name the group uses', async () => {
    const declarations = memoryDeclarationStore();
    await declarations.record({
      group: GROUP,
      dayNumber: TODAY - 1,
      sender: '33611111111@s.whatsapp.net',
      score: 4,
      capped: false,
      token: 't',
      messageId: 'X',
      messageTs: 1,
      name: 'Zou',
      receivedAt: '',
      lang: 'fr',
    });
    const { provider, requests } = scripted([() => ({ text: 'ok' })]);
    const answer = agentWith(provider, { declarations });
    await answer(
      message('@33700000000 combien de jours que @33611111111 me bat ?', {
        mentions: ['33700000000@s.whatsapp.net', '33611111111@s.whatsapp.net'],
      }),
      group,
      identity,
      TODAY,
    );
    // The bot's own mention is addressing and goes; the other becomes a name the tools can
    // look up, and never the phone number behind it.
    const asked = (requests[0].messages.at(-1) as { content: string }).content;
    expect(asked).toBe('Gab: combien de jours que Zou me bat ?');
    expect(asked).not.toContain('33611111111');
  });

  it('names an unknown mention by its handle, and still charges nothing for a bare one', async () => {
    const { provider, requests } = scripted([() => ({ text: 'ok' })]);
    const answer = agentWith(provider);
    // Nobody the group has seen: the same …last4 handle every other surface shows.
    await answer(
      message('@33700000000 et @33699998888 alors ?', {
        mentions: ['33700000000@s.whatsapp.net', '33699998888@s.whatsapp.net'],
      }),
      group,
      identity,
      TODAY,
    );
    expect((requests[0].messages.at(-1) as { content: string }).content).toBe('Gab: et …8888 alors ?');
    // Two bare mentions and no words is still not a question.
    expect(
      await answer(
        message('@33700000000 @33699998888', {
          id: 'M9',
          mentions: ['33700000000@s.whatsapp.net', '33699998888@s.whatsapp.net'],
        }),
        group,
        identity,
        TODAY,
      ),
    ).toEqual({ kind: 'silent', reason: 'empty' });
  });

  it('bounds a reply to plain text of a sane length', () => {
    expect(plainReply('**Gros** _titre_\n\n\nligne')).toBe('Gros titre\nligne');
    const long = plainReply(`${'Phrase courte. '.repeat(80)}`)!;
    expect(long.length).toBeLessThanOrEqual(700);
    expect(long.endsWith('.')).toBe(true);
    expect(plainReply('   ')).toBeNull();
  });
});
