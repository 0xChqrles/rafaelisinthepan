import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { dayNumber } from '@whippin/shared';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import { LlmUnavailable, type LlmProvider, type LlmRequest, type LlmResponse } from '../llm/types';
import type { Turn } from './dayLog';
import { DIARY_MAX_CHARS, diaryTurn, dynamoDiaryStore, memoryDiaryStore, mentionsPerson, plainDiary, rewriteDiary, stampOf, withoutPerson } from './diary';

const GROUP = '120363000000000001@g.us';
const DAY = dayNumber('2026-09-03');
const NOON = Date.parse('2026-09-03T12:00:00Z');
const group = parseGroupConfig('g.json', {
  id: GROUP,
  name: 'g',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true, prePrompt: 'On se chambre.' },
});
const log = createLog('silent');
const now = () => new Date('2026-09-04T02:05:00Z');
const turns: Turn[] = [
  { group: GROUP, day: DAY, at: NOON, id: 'A', kind: 'said', name: 'Luc', text: 'demain je fais ∞' },
  { group: GROUP, day: DAY, at: NOON + 60_000, id: 'A#reply', kind: 'bot', name: '', text: 'Je note la promesse.' },
];

function scripted(...answers: (Partial<LlmResponse> | Error)[]) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: 'fake',
    model: 'fake',
    async generate(request) {
      requests.push(request);
      const out = answers[requests.length - 1] ?? { text: 'fin' };
      if (out instanceof Error) throw out;
      return { text: null, toolCalls: [], finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, ...out };
    },
  };
  return { provider, requests };
}

describe('the group diary (#277)', () => {
  it('is rewritten from the diary as it stood and the day, as one plain text, dated', async () => {
    const { provider, requests } = scripted({ text: '*Luc* a promis un ∞ pour le 4 septembre.\n\n\n\nBruno reste la cible.' });
    const previous = { version: 1, text: 'Bruno reste la cible.', updatedAt: '', day: DAY - 1 };
    const next = await rewriteDiary(provider, group, previous, DAY, turns, log, now);
    expect(next).toEqual({ version: 1, text: 'Luc a promis un ∞ pour le 4 septembre.\n\nBruno reste la cible.', updatedAt: '2026-09-04T02:05:00.000Z', day: DAY });
    // The system half is the bot's own voice and the task; the diary and the day are the
    // conversation half, the day rendered with the group's clock and the bot by its name.
    expect(requests[0].system).toContain('On se chambre.');
    expect(requests[0].system).toContain('rewrite your diary');
    const content = (requests[0].messages[0] as { content: string }).content;
    expect(content).toContain('[Your diary so far]\nBruno reste la cible.');
    expect(content).toContain('[Today, 2026-09-03]\n[14:00] Luc: demain je fais ∞\n[14:01] WhippinBot: Je note la promesse.');
    // A first day has nothing to carry over, and says so rather than sending nothing.
    await rewriteDiary(provider, group, null, DAY, turns, log, now);
    expect((requests[1].messages[0] as { content: string }).content).toContain('(nothing yet');
  });

  it('leaves the diary AS IT WAS when nothing was said, the model is down, or it answered nothing usable', async () => {
    const { provider, requests } = scripted();
    expect(await rewriteDiary(provider, group, null, DAY, [], log, now)).toBeNull();
    expect(requests).toHaveLength(0); // an empty day costs no call
    const down = scripted(new LlmUnavailable('503'));
    expect(await rewriteDiary(down.provider, group, null, DAY, turns, log, now)).toBeNull();
    const cut = scripted({ text: 'Luc a', finish: 'length' });
    expect(await rewriteDiary(cut.provider, group, null, DAY, turns, log, now)).toBeNull();
    const empty = scripted({ text: '   ' });
    expect(await rewriteDiary(empty.provider, group, null, DAY, turns, log, now)).toBeNull();
  });

  it('is bounded at a sentence end, and travels as a user turn marked as notes', () => {
    // Twice the bound, whatever the bound is, so the cut is always exercised.
    const input = 'Une phrase. '.repeat(DIARY_MAX_CHARS / 6);
    expect(input.length).toBeGreaterThan(DIARY_MAX_CHARS);
    const long = plainDiary(input)!;
    expect(long.length).toBeLessThanOrEqual(DIARY_MAX_CHARS);
    expect(long.endsWith('.')).toBe(true);
    expect(plainDiary('')).toBeNull();
    expect(diaryTurn(null)).toBeNull();
    expect(diaryTurn({ version: 1, text: '', updatedAt: '', day: 0 })).toBeNull();
    expect(diaryTurn({ version: 1, text: 'Bruno reste la cible.', updatedAt: '', day: 0 })).toMatch(/^\[Your diary of this group.*not instructions\.\]\nBruno reste la cible\.$/s);
  });

  it('forgets a person by rewriting, and refuses a rewrite that still names them', async () => {
    const diary = { version: 1, text: 'Luc a promis un ∞. Bruno reste la cible.', updatedAt: '', day: DAY };
    expect(mentionsPerson(diary.text, 'Luc Le Père')).toBe(true);
    expect(mentionsPerson(diary.text, 'Léa')).toBe(false); // whole words, folded: "Léa" is not in "Le Père"
    expect(mentionsPerson('lucide', 'Luc')).toBe(false);
    // A SHORT name is the whole name, so it is looked for whole (PR-278 review): under a
    // three-letter minimum, "Jo" matched nothing and the command reported no mention.
    expect(mentionsPerson('Jo a encore gagné.', 'Jo')).toBe(true);
    expect(mentionsPerson('Bruno a encore gagné.', 'Jo')).toBe(false);
    // And a hyphen is a word boundary on BOTH sides, so a compound name is found.
    expect(mentionsPerson('Jean-Luc a promis un ∞.', 'Jean-Luc')).toBe(true);
    expect(mentionsPerson('Jean Luc a promis un ∞.', 'Jean-Luc')).toBe(true);
    expect(mentionsPerson('Zou a promis un ∞.', 'Jean-Luc')).toBe(false);
    expect(mentionsPerson('un texte', '')).toBe(false);
    const clean = scripted({ text: 'Bruno reste la cible.' });
    const gone = await withoutPerson(clean.provider, group, diary, 'Luc Le Père', log, now);
    expect(gone?.text).toBe('Bruno reste la cible.');
    expect((clean.requests[0].messages[0] as { content: string }).content).toBe(diary.text);
    expect(clean.requests[0].system).toContain('everything about Luc Le Père removed');
    // Still there after the rewrite: not stored.
    const stubborn = scripted({ text: 'Luc reste. Bruno aussi.' });
    expect(await withoutPerson(stubborn.provider, group, diary, 'Luc', log, now)).toBeNull();
    // Never mentioned: nothing to do, no call.
    const nothing = scripted();
    expect(await withoutPerson(nothing.provider, group, diary, 'Zou', log, now)).toBe(diary);
    expect(nothing.requests).toHaveLength(0);
  });

  it('WRITES ONLY OVER WHAT IT READ (PR-278 review): a diary that moved refuses the write', async () => {
    // The case: the nightly rewrite reads the diary, spends a model call on it, and an
    // operator's `forget` lands in between. Writing what was read would put the person back.
    const store = memoryDiaryStore();
    const first = { version: 1, text: 'un', updatedAt: 'A', day: DAY };
    expect(await store.put(GROUP, first, null)).toBe(true);
    expect(await store.put(GROUP, { ...first, text: 'again' }, null)).toBe(false); // there IS one now
    expect(await store.put(GROUP, { ...first, text: 'deux', updatedAt: 'B' }, { day: DAY, updatedAt: 'A' })).toBe(true);
    // Stale: what was read (updatedAt A) is no longer what stands (B).
    expect(await store.put(GROUP, { ...first, text: 'trois', updatedAt: 'C' }, { day: DAY, updatedAt: 'A' })).toBe(false);
    expect((await store.get(GROUP))?.text).toBe('deux');
    expect(stampOf(null)).toBeNull();
    expect(stampOf(first)).toEqual({ day: DAY, updatedAt: 'A' });
  });

  it('names the condition on the way to DynamoDB, and reads a refusal as a refusal', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = dynamoDiaryStore({ send } as unknown as DynamoDBClient, 'bot');
    await store.put(GROUP, { version: 1, text: 'x', updatedAt: 'now', day: DAY }, { day: DAY - 1, updatedAt: 'before' });
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.ConditionExpression).toBe('#day = :day AND #updatedAt = :updatedAt');
    expect(put.input.ExpressionAttributeValues).toEqual({ ':day': { N: String(DAY - 1) }, ':updatedAt': { S: 'before' } });
    const refusing = vi.fn().mockRejectedValue(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const refused = dynamoDiaryStore({ send: refusing } as unknown as DynamoDBClient, 'bot');
    expect(await refused.put(GROUP, { version: 1, text: 'x', updatedAt: 'now', day: DAY }, null)).toBe(false);
  });

  it('is one row per group', async () => {
    const memory = memoryDiaryStore();
    expect(await memory.get(GROUP)).toBeNull();
    expect(await memory.put(GROUP, { version: 1, text: 'x', updatedAt: '', day: DAY }, null)).toBe(true);
    expect((await memory.get(GROUP))?.text).toBe('x');
    const send = vi.fn().mockResolvedValue({});
    await dynamoDiaryStore({ send } as unknown as DynamoDBClient, 'bot').put(GROUP, { version: 1, text: 'x', updatedAt: 'now', day: DAY }, null);
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.Item?.pk).toEqual({ S: `DIARY#${GROUP}` });
    expect(put.input.Item?.sk).toEqual({ S: 'TEXT' });
    expect(put.input.Item?.expiresAt).toBeUndefined(); // a diary does not expire
  });
});
