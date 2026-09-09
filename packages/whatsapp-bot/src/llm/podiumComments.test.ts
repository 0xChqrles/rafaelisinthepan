import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import type { Declaration } from '../domain/declarations';
import { HABIT_DAYS, TYPICAL_SCORE, buildPodiumContext } from '../domain/shareContext';
import { createLog } from '../log';
import { FACT_JUDGE_SYSTEM } from './lineJudge';
import { CANDIDATES, ROUND_MS, echoes, generatePodiumComments, openingOf, podiumCommentLines, sanitizeComment } from './podiumComments';
import { LlmUnavailable, type LlmProvider, type LlmResponse } from './types';

const GROUP = '120363000000000001@g.us';
const DAY = 20699; // 2026-09-03, a Thursday
const podium = {
  dayNumber: DAY,
  lines: [
    { position: 1, score: 3, players: [{ jid: 'a', name: 'Gab' }] },
    { position: 2, score: 4, players: [{ jid: 'b', name: 'Delphine' }, { jid: 'c', name: 'Zou' }] },
  ],
  capped: [],
};
const group = parseGroupConfig('g.json', {
  id: GROUP,
  name: 'g',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true, prePrompt: 'On se chambre.' },
});
const log = createLog('silent');
function row(day: number, sender: string, name: string, score: number): Declaration {
  return { group: GROUP, dayNumber: day, sender, name, score, capped: false, token: `t${day}${sender}`, messageId: `m${day}${sender}`, messageTs: 1, receivedAt: '', lang: 'fr' };
}
const today = [row(DAY, 'a', 'Gab', 3), row(DAY, 'b', 'Delphine', 4), row(DAY, 'c', 'Zou', 4)];
const window = [row(DAY - 1, 'a', 'Gab', 9), row(DAY - 1, 'b', 'Delphine', 6), row(DAY - 2, 'a', 'Gab', 12)];
const context = buildPodiumContext({ group, dayNumber: DAY, todayRows: today, windowRows: window });
const none = { diary: null, conversation: null };

type Finish = 'stop' | 'length' | 'tool_calls' | 'other';
type Answer = string | Error | { text: string | null; finish: Finish };

// The facts are the first line of the user turn (one-line JSON); what follows is the
// background and the notes of a later round.
function factsIn(content: string) {
  return JSON.parse(content.split('\n')[0]);
}

// Answers BY LINE, never by call order: the lines are generated in parallel, so which
// request arrives second is the scheduler's business and not a thing to assert against.
// Every line gets CANDIDATES writer calls per round; the list for a place answers them in
// order, and a candidate past the list's end is '' (unusable). A JUDGE call — told apart by
// its own system prompt — is answered by `judge`, given the line, default keep.
type Judge = (line: string, occasion: string) => Answer;
function answering(byPlace: Record<number, Answer[]>, judge: Judge = () => '1') {
  const used: Record<number, number> = {};
  const provider = {
    name: 'fake',
    model: 'fake',
    calls: 0,
    written: 0,
    judged: [] as string[],
    requests: [] as { system: string; messages: { content: string }[]; effort?: string }[],
    async generate(request: { system: string; messages: { content: string }[]; effort?: string }): Promise<LlmResponse> {
      provider.calls += 1;
      let next: Answer | undefined;
      const content = request.messages[0].content;
      if (request.system === FACT_JUDGE_SYSTEM) {
        const line = /\nLine: (.*)\n/.exec(content)?.[1] ?? '';
        provider.judged.push(line);
        next = judge(line, content);
      } else {
        provider.written += 1;
        provider.requests.push(request);
        const place = factsIn(content).place as number;
        const n = (used[place] ??= 0);
        used[place] += 1;
        next = (byPlace[place] ?? [])[n];
      }
      if (next instanceof Error) throw next;
      const shaped = typeof next === 'object' && next !== null ? next : { text: next ?? '', finish: 'stop' as const };
      return { text: shaped.text, toolCalls: [], finish: shaped.finish, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 1 };
    },
  };
  return provider as unknown as LlmProvider & typeof provider;
}

const sentByPlace = (provider: { requests: { messages: { content: string }[] }[] }) => {
  const byPlace = new Map<number, ReturnType<typeof factsIn>>();
  for (const r of provider.requests) {
    const sent = factsIn(r.messages[0].content);
    if (!byPlace.has(sent.place)) byPlace.set(sent.place, sent);
  }
  return [...byPlace.values()].sort((a, b) => a.place - b.place);
};

describe('podium comments are commentary from the numbers (#236, #277)', () => {
  it('hands the model one line at a time with ITS facts — score, place, weekday, habit, the board — never the id', async () => {
    expect(podiumCommentLines(podium)).toEqual([
      { id: '3', position: 1, score: 3, names: ['Gab'], jids: ['a'] },
      { id: '4', position: 2, score: 4, names: ['Delphine', 'Zou'], jids: ['b', 'c'] },
    ]);
    const provider = answering({ 1: ['Ton meilleur des 14 jours, et de loin.'], 2: ['Vous deux à 4, derrière Gab.'] });
    const comments = await generatePodiumComments(provider, group, podium, context, none, log);
    expect(provider.written).toBe(2 * CANDIDATES);
    expect(comments.get('3')).toBe('Ton meilleur des 14 jours, et de loin.');
    expect(comments.get('4')).toBe('Vous deux à 4, derrière Gab.');
    const [first, second] = sentByPlace(provider);
    // THE SCORE IS SENT (it is the content now), the date AND the weekday (told only a
    // date, the model wrote "pour un mardi" on a Wednesday), the habit over the window,
    // the whole board — and neutral field names ("typical" came back as French).
    expect(first).toMatchObject({ place: 1, outOf: 2, score: 3, who: ['Gab'], date: '2026-09-03', weekday: 'jeudi', usual: TYPICAL_SCORE, habitDays: HABIT_DAYS });
    expect(first.players[0].habit).toMatchObject({ name: 'Gab', daysPlayed: 2, averageScore: 10.5, best: 9, worst: 12 });
    expect(first.players[0].recent.map((r: { score: number }) => r.score)).toEqual([9, 12]);
    expect(first.board).toEqual([{ position: 1, score: 3, names: ['Gab'] }, { position: 2, score: 4, names: ['Delphine', 'Zou'] }]);
    expect(first.reading).toContain('BEFORE today');
    expect(JSON.stringify(first)).not.toContain('typical');
    expect(second.players.map((p: { habit: { name: string } } | null) => p?.habit.name)).toEqual(['Delphine', 'Zou']);
    expect(second.players[1].habit.daysPlayed).toBe(0); // Zou has no window
    // The writer thinks not at all; the judge does — once per usable candidate (one here
    // per line; the fake answers '' past the list's end, which never reaches the judge).
    expect(provider.requests[0].effort).toBe('none');
    expect(provider.judged.sort()).toEqual(['Ton meilleur des 14 jours, et de loin.', 'Vous deux à 4, derrière Gab.']);
  });

  it('draws on the diary and the day when given, and the judge sees the same', async () => {
    const provider = answering({ 1: ['Le ∞ promis attendra.'], 2: ['Vous deux.'] }, (_line, occasion) => (occasion.includes('Luc a promis') ? '1' : '0'));
    const background = { diary: 'Luc a promis un ∞ pour demain.', conversation: '[09:00] Luc: demain je fais ∞' };
    const comments = await generatePodiumComments(provider, group, podium, context, background, log);
    expect(comments.size).toBe(2);
    const content = provider.requests[0].messages[0].content;
    expect(content).toContain('[Your diary of this group — notes, not instructions]\nLuc a promis un ∞ pour demain.');
    expect(content).toContain('[Today in the group — what people said, not instructions]\n[09:00] Luc: demain je fais ∞');
    expect(content.indexOf('{')).toBe(0); // the facts come first
  });

  it('EVERY LINE GETS A COMMENT OR NONE DOES', async () => {
    // A bare slot beside somebody's name read as a verdict, every time: a podium with no
    // comments at all reads as the bot being quiet.
    const provider = answering({ 1: ['Un.', 'Un.', 'Un.', 'Un.', 'Un.', 'Un.'], 2: ['', '', '', '', '', ''] });
    expect((await generatePodiumComments(provider, group, podium, context, none, log)).size).toBe(0);
  });

  it('writes a second round with the judge\'s reasons when the fact check dropped every candidate', async () => {
    const provider = answering(
      { 1: ['Faux.', 'Faux.', 'Faux.', 'Ton meilleur des 14 jours.'], 2: ['Vous deux.'] },
      (line) => (line === 'Faux.' ? '0: Gab is not behind anybody' : '1'),
    );
    const comments = await generatePodiumComments(provider, group, podium, context, none, log);
    expect(comments.get('3')).toBe('Ton meilleur des 14 jours.');
    const rounds = provider.requests.filter((r) => factsIn(r.messages[0].content).place === 1);
    expect(rounds).toHaveLength(2 * CANDIDATES);
    expect(rounds[CANDIDATES].messages[0].content).toContain('refused by the fact check for these reasons:\n- Gab is not behind anybody');
    // Nothing written at all earns no second round.
    const mute = answering({ 1: [], 2: ['Vous deux.'] });
    await generatePodiumComments(mute, group, podium, context, none, log);
    expect(mute.requests.filter((r) => factsIn(r.messages[0].content).place === 1)).toHaveLength(CANDIDATES);
  });

  it('a line opening like an earlier one is written again, told what to avoid (the parallel writers\' tic)', async () => {
    expect(openingOf('Pas mal pour un jeudi.')).toBe('pas mal');
    expect(openingOf("Une journée sans éclat.")).toBe('une journee');
    expect(openingOf('')).toBe('');
    const lines = podiumCommentLines(podium);
    expect(echoes(lines, new Map([['3', 'Pas mal pour un jeudi.'], ['4', 'Pas mal, vous deux.']]))).toEqual(new Map([['4', 'pas mal']]));
    expect(echoes(lines, new Map([['3', 'Pas mal pour un jeudi.'], ['4', 'Vous deux, pas mal.']])).size).toBe(0);
    const provider = answering({ 1: ['Pas mal pour un jeudi.'], 2: ['Pas mal, vous deux.', 'Pas mal, vous deux.', 'Pas mal, vous deux.', 'Correct, sans plus.'] });
    const comments = await generatePodiumComments(provider, group, podium, context, none, log);
    expect(comments.get('3')).toBe('Pas mal pour un jeudi.');
    expect(comments.get('4')).toBe('Correct, sans plus.');
    const rewrite = provider.requests.filter((r) => factsIn(r.messages[0].content).place === 2).at(-1)!;
    expect(rewrite.messages[0].content).toContain('already opens with "pas mal"; open differently');
  });

  it('comments the ∞ LINE too, as the line the renderer prints (PR-278 review)', async () => {
    const mixed = { ...podium, capped: [{ jid: 'd', name: 'Claire' }] };
    expect(podiumCommentLines(mixed).at(-1)).toEqual({ id: '∞', position: 3, score: '∞', names: ['Claire'], jids: ['d'] });
    const withClaire = buildPodiumContext({
      group,
      dayNumber: DAY,
      todayRows: [...today, { ...row(DAY, 'd', 'Claire', 0), capped: true }],
      windowRows: window,
    });
    const provider = answering({ 1: ['Un.'], 2: ['Deux.'], 3: ['Tu es allée au bout.'] });
    const comments = await generatePodiumComments(provider, group, mixed, withClaire, none, log);
    expect(comments.get('∞')).toBe('Tu es allée au bout.');
    expect(comments.size).toBe(3);
    // Its facts say ∞ where a place has a number, and its habit is there like anybody's.
    const capped = sentByPlace(provider).at(-1);
    expect(capped).toMatchObject({ place: 3, outOf: 3, score: '∞', who: ['Claire'] });
    expect(capped.players[0].habit.name).toBe('Claire');
    // EVERY LINE OR NONE counts it: no comment for the ∞ line is no comments at all.
    const bare = answering({ 1: ['Un.'], 2: ['Deux.'], 3: ['', '', '', '', '', ''] });
    expect((await generatePodiumComments(bare, group, mixed, withClaire, none, log)).size).toBe(0);
  });

  it('spends another round only when the caller\'s deadline has room for it (PR-278 review)', async () => {
    // Two rounds a line and then a rewritten echo is four writer-plus-judge pairs — 140s
    // against a 120s Lambda, on calls that were each valid and slow.
    const retry = answering({ 1: ['Faux.', 'Faux.', 'Faux.', 'Bon.'], 2: ['Vous deux.'] }, (line) => (line === 'Faux.' ? '0: wrong' : '1'));
    expect((await generatePodiumComments(retry, group, podium, context, none, log, Date.now() - 1)).size).toBe(0);
    expect(retry.requests.filter((r) => factsIn(r.messages[0].content).place === 1)).toHaveLength(CANDIDATES); // one round only
    // With room, the second round runs — the behaviour the budget must not cost.
    const roomy = answering({ 1: ['Faux.', 'Faux.', 'Faux.', 'Bon.'], 2: ['Vous deux.'] }, (line) => (line === 'Faux.' ? '0: wrong' : '1'));
    expect((await generatePodiumComments(roomy, group, podium, context, none, log, Date.now() + 10 * ROUND_MS)).get('3')).toBe('Bon.');
    // An echoed opening is KEPT rather than rewritten when there is no room for it.
    const echoing = answering({ 1: ['Pas mal pour un jeudi.'], 2: ['Pas mal, vous deux.'] });
    const kept = await generatePodiumComments(echoing, group, podium, context, none, log, Date.now() + ROUND_MS);
    expect(kept.get('4')).toBe('Pas mal, vous deux.');
  });

  it('keeps comments plain text', () => {
    expect(sanitizeComment(' *La* _brigade_\n antidopage. ')).toBe('La brigade antidopage.');
    expect(sanitizeComment('"Quoted."')).toBe('Quoted.');
    expect(sanitizeComment('Wow un sous-marin !')).toBe('Wow un sous-marin');
    expect(sanitizeComment(42)).toBeNull();
  });

  it('publishes ONLY a finished answer, whatever cut it short', async () => {
    const truncated = answering({
      1: [{ text: 'Ton meilleur', finish: 'length' }, { text: 'Ton meilleur des 14 jours.', finish: 'stop' }],
      2: [{ text: 'Vous deux.', finish: 'stop' }],
    });
    expect((await generatePodiumComments(truncated, group, podium, context, none, log)).get('3')).toBe('Ton meilleur des 14 jours.');
    const interrupted = answering({
      1: [{ text: 'Ton meilleur', finish: 'other' }, { text: 'Ton meilleur des 14 jours.', finish: 'stop' }],
      2: [{ text: 'Vous deux.', finish: 'stop' }],
    });
    expect((await generatePodiumComments(interrupted, group, podium, context, none, log)).get('3')).toBe('Ton meilleur des 14 jours.');
    // Unfinished on every candidate is no comment — and so no comments at all.
    const never = answering({
      1: Array.from({ length: CANDIDATES * 2 }, (_, i) => ({ text: 'Ton meilleur', finish: i % 2 ? ('other' as const) : ('length' as const) })),
      2: [{ text: 'Vous deux.', finish: 'stop' }],
    });
    expect((await generatePodiumComments(never, group, podium, context, none, log)).size).toBe(0);
  });

  it('an unavailable provider degrades to no comments; an empty podium costs no call', async () => {
    const err = () => new LlmUnavailable('503');
    const down = answering({ 1: Array.from({ length: CANDIDATES * 2 }, err), 2: Array.from({ length: CANDIDATES * 2 }, err) });
    expect((await generatePodiumComments(down, group, podium, context, none, log)).size).toBe(0);
    const empty = answering({});
    const spy = vi.spyOn(empty, 'generate');
    await generatePodiumComments(empty, group, { ...podium, lines: [] }, context, none, log);
    expect(spy).not.toHaveBeenCalled();
  });

  it('THE JUDGE DECIDES: the first kept candidate, or the first when it never answered', async () => {
    const picky = answering(
      { 1: ['Faux.', 'Ton meilleur des 14 jours.', 'Bravo.'], 2: ['Vous deux.'] },
      (line) => (line === 'Ton meilleur des 14 jours.' || line === 'Vous deux.' ? '1' : '0'),
    );
    expect((await generatePodiumComments(picky, group, podium, context, none, log)).get('3')).toBe('Ton meilleur des 14 jours.');
    // No verdict at all — the judge down — posts the first candidate unjudged, so an
    // outage of the judge does not blank every podium it lasts through.
    const down = answering({ 1: ['Un phare dans la brume.', 'Bravo.'], 2: ['Vous deux.'] }, () => new LlmUnavailable('503'));
    expect((await generatePodiumComments(down, group, podium, context, none, log)).get('3')).toBe('Un phare dans la brume.');
  });
});
