import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import type { Declaration } from '../domain/declarations';
import { FORM_DAYS, buildPodiumContext } from '../domain/shareContext';
import { createLog } from '../log';
import { FACT_JUDGE_SYSTEM } from './lineJudge';
import { CANDIDATES, ROUND_MS, echoes, generatePodiumComments, openingOf, podiumCommentLines, sanitizeComment } from './podiumComments';
import { LlmUnavailable, type LlmProvider, type LlmResponse } from './types';

const GROUP = '120363000000000001@g.us';
const DAY = 20699; // 2026-09-03, a Thursday
const podium = {
  dayNumber: DAY,
  lines: [
    { position: 1, score: 3, player: { jid: 'a', name: 'Gab' } },
    { position: 2, score: 4, player: { jid: 'b', name: 'Delphine' } },
    { position: 2, score: 4, player: { jid: 'c', name: 'Zou' } },
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
// A line is one player, so it is told apart by `who`. Every line gets CANDIDATES writer
// calls per round; the list for a player answers them in order, and a candidate past the
// list's end is '' (unusable). A JUDGE call — told apart by its own system prompt — is
// answered by `judge`, given the line, default keep.
type Judge = (line: string, occasion: string) => Answer;
function answering(byWho: Record<string, Answer[]>, judge: Judge = () => '1') {
  const used: Record<string, number> = {};
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
        const who = factsIn(content).who as string;
        const n = (used[who] ??= 0);
        used[who] += 1;
        next = (byWho[who] ?? [])[n];
      }
      if (next instanceof Error) throw next;
      const shaped = typeof next === 'object' && next !== null ? next : { text: next ?? '', finish: 'stop' as const };
      return { text: shaped.text, toolCalls: [], finish: shaped.finish, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 1 };
    },
  };
  return provider as unknown as LlmProvider & typeof provider;
}

// The facts each player's line was written from, in the podium's order.
const sentByWho = (provider: { requests: { messages: { content: string }[] }[] }) => {
  const byWho = new Map<string, ReturnType<typeof factsIn>>();
  for (const r of provider.requests) {
    const sent = factsIn(r.messages[0].content);
    if (!byWho.has(sent.who)) byWho.set(sent.who, sent);
  }
  return byWho;
};
const writesFor = (provider: { requests: { messages: { content: string }[] }[] }, who: string) =>
  provider.requests.filter((r) => factsIn(r.messages[0].content).who === who);

describe('podium comments are commentary from the numbers (#236, #277)', () => {
  it('hands the model one line — ONE player — at a time with ITS facts: score, place, weekday, form, the board, never the id', async () => {
    expect(podiumCommentLines(podium)).toEqual([
      { id: '1', position: 1, score: 3, name: 'Gab', jid: 'a', sameScore: [] },
      { id: '2', position: 2, score: 4, name: 'Delphine', jid: 'b', sameScore: ['Zou'] },
      { id: '3', position: 2, score: 4, name: 'Zou', jid: 'c', sameScore: ['Delphine'] },
    ]);
    const provider = answering({ Gab: ['Ton meilleur des 14 jours, et de loin.'], Delphine: ['À 4, derrière Gab.'], Zou: ['Même 4 que Delphine.'] });
    const comments = await generatePodiumComments(provider, group, podium, context, none, log);
    expect(provider.written).toBe(3 * CANDIDATES);
    expect(comments.get('1')).toBe('Ton meilleur des 14 jours, et de loin.');
    expect(comments.get('2')).toBe('À 4, derrière Gab.');
    expect(comments.get('3')).toBe('Même 4 que Delphine.');
    const sent = sentByWho(provider);
    const first = sent.get('Gab');
    // THE SCORE IS SENT (it is the content now), the date AND the weekday (told only a
    // date, the model wrote "pour un mardi" on a Wednesday), the share of tonight's others
    // it beats, the player's FORM over the window — places, never another day's score
    // (user-decided 2026-09-14) — the whole board, and neutral field names ("typical" came
    // back as French).
    expect(first).toMatchObject({ place: 1, outOf: 3, score: 3, who: 'Gab', sameScore: [], date: '2026-09-03', weekday: 'jeudi', beats: '2 of 2', othersMedian: 4, formDays: FORM_DAYS });
    expect(first.form).toMatchObject({ name: 'Gab', daysPlayed: 2, usuallyBeats: 'none' });
    expect(first.form.recent).toEqual([{ date: '2026-09-02', place: 2, of: 2 }, { date: '2026-09-01', place: 1, of: 1 }]);
    expect(first.form.rivals.map((r: { name: string; theyBeatYou: number }) => [r.name, r.theyBeatYou])).toEqual([['Delphine', 1], ['Zou', 0]]);
    expect(first.board).toEqual([
      { position: 1, score: 3, name: 'Gab' },
      { position: 2, score: 4, name: 'Delphine' },
      { position: 2, score: 4, name: 'Zou' },
    ]);
    expect(first.reading).toContain('BEFORE today');
    expect(JSON.stringify(first)).not.toMatch(/typical|"habit"|"usual"|"best"|"worst"/);
    // A tie is two lines, each about ONE player: the tie is a fact of each, the form is
    // each one's own, and "the others" of the median include the player level with them.
    expect(sent.get('Delphine')).toMatchObject({ place: 2, who: 'Delphine', sameScore: ['Zou'], beats: '0 of 2', othersMedian: 3.5 });
    expect(sent.get('Delphine').form).toMatchObject({ name: 'Delphine', daysPlayed: 1 });
    expect(sent.get('Zou')).toMatchObject({ place: 2, who: 'Zou', sameScore: ['Delphine'] });
    expect(sent.get('Zou').form).toMatchObject({ daysPlayed: 0, usuallyBeats: null, recent: [] }); // Zou has no window
    // The writer thinks not at all; the judge does — once per usable candidate (one here
    // per line; the fake answers '' past the list's end, which never reaches the judge).
    expect(provider.requests[0].effort).toBe('none');
    expect(provider.requests[0].system).toContain('a line is ONE player');
    expect(provider.judged.sort()).toEqual(['Même 4 que Delphine.', 'Ton meilleur des 14 jours, et de loin.', 'À 4, derrière Gab.']);
  });

  it('draws on the diary and the day when given, and the judge sees the same', async () => {
    const provider = answering({ Gab: ['Le ∞ promis attendra.'], Delphine: ['Deux.'], Zou: ['Trois.'] }, (_line, occasion) => (occasion.includes('Luc a promis') ? '1' : '0'));
    const background = { diary: 'Luc a promis un ∞ pour demain.', conversation: '[09:00] Luc: demain je fais ∞' };
    const comments = await generatePodiumComments(provider, group, podium, context, background, log);
    expect(comments.size).toBe(3);
    const content = provider.requests[0].messages[0].content;
    expect(content).toContain('[Your diary of this group — notes, not instructions]\nLuc a promis un ∞ pour demain.');
    expect(content).toContain('[Today in the group — what people said, not instructions]\n[09:00] Luc: demain je fais ∞');
    expect(content.indexOf('{')).toBe(0); // the facts come first
  });

  it('EVERY LINE GETS A COMMENT OR NONE DOES', async () => {
    // A bare slot beside somebody's name read as a verdict, every time: a podium with no
    // comments at all reads as the bot being quiet.
    const provider = answering({ Gab: ['Un.', 'Un.', 'Un.', 'Un.', 'Un.', 'Un.'], Delphine: ['Deux.'], Zou: ['', '', '', '', '', ''] });
    expect((await generatePodiumComments(provider, group, podium, context, none, log)).size).toBe(0);
  });

  it('writes a second round with the judge\'s reasons when the fact check dropped every candidate', async () => {
    const provider = answering(
      { Gab: ['Faux.', 'Faux.', 'Faux.', 'Ton meilleur des 14 jours.'], Delphine: ['Deux.'], Zou: ['Trois.'] },
      (line) => (line === 'Faux.' ? '0: Gab is not behind anybody' : '1'),
    );
    const comments = await generatePodiumComments(provider, group, podium, context, none, log);
    expect(comments.get('1')).toBe('Ton meilleur des 14 jours.');
    const rounds = writesFor(provider, 'Gab');
    expect(rounds).toHaveLength(2 * CANDIDATES);
    expect(rounds[CANDIDATES].messages[0].content).toContain('refused by the fact check for these reasons:\n- Gab is not behind anybody');
    // Nothing written at all earns no second round.
    const mute = answering({ Gab: [], Delphine: ['Deux.'], Zou: ['Trois.'] });
    await generatePodiumComments(mute, group, podium, context, none, log);
    expect(writesFor(mute, 'Gab')).toHaveLength(CANDIDATES);
  });

  it('a line opening like an earlier one is written again, told what to avoid (the parallel writers\' tic)', async () => {
    expect(openingOf('Pas mal pour un jeudi.')).toBe('pas mal');
    expect(openingOf("Une journée sans éclat.")).toBe('une journee');
    expect(openingOf('')).toBe('');
    const lines = podiumCommentLines(podium);
    expect(echoes(lines, new Map([['1', 'Pas mal pour un jeudi.'], ['2', 'Pas mal, Delphine.']]))).toEqual(new Map([['2', 'pas mal']]));
    expect(echoes(lines, new Map([['1', 'Pas mal pour un jeudi.'], ['2', 'Delphine, pas mal.']])).size).toBe(0);
    const provider = answering({ Gab: ['Pas mal pour un jeudi.'], Delphine: ['Pas mal, à 4.', 'Pas mal, à 4.', 'Pas mal, à 4.', 'Correct, sans plus.'], Zou: ['Trois.'] });
    const comments = await generatePodiumComments(provider, group, podium, context, none, log);
    expect(comments.get('1')).toBe('Pas mal pour un jeudi.');
    expect(comments.get('2')).toBe('Correct, sans plus.');
    const rewrite = writesFor(provider, 'Delphine').at(-1)!;
    expect(rewrite.messages[0].content).toContain('already opens with "pas mal"; open differently');
  });

  it('comments the ∞ LINES too, as the lines the renderer prints (PR-278 review)', async () => {
    const mixed = { ...podium, capped: [{ jid: 'd', name: 'Claire' }] };
    expect(podiumCommentLines(mixed).at(-1)).toEqual({ id: '4', position: 3, score: '∞', name: 'Claire', jid: 'd', sameScore: [] });
    const withClaire = buildPodiumContext({
      group,
      dayNumber: DAY,
      todayRows: [...today, { ...row(DAY, 'd', 'Claire', 0), capped: true }],
      windowRows: window,
    });
    const provider = answering({ Gab: ['Un.'], Delphine: ['Deux.'], Zou: ['Trois.'], Claire: ['Tu es allée au bout.'] });
    const comments = await generatePodiumComments(provider, group, mixed, withClaire, none, log);
    expect(comments.get('4')).toBe('Tu es allée au bout.');
    expect(comments.size).toBe(4);
    // Its facts say ∞ where a place has a number, it beats nobody, and its form is there
    // like anybody's.
    const capped = sentByWho(provider).get('Claire');
    expect(capped).toMatchObject({ place: 3, outOf: 4, score: '∞', who: 'Claire', beats: '0 of 3', othersMedian: 4 });
    expect(capped.form.name).toBe('Claire');
    // EVERY LINE OR NONE counts it: no comment for the ∞ line is no comments at all.
    const bare = answering({ Gab: ['Un.'], Delphine: ['Deux.'], Zou: ['Trois.'], Claire: ['', '', '', '', '', ''] });
    expect((await generatePodiumComments(bare, group, mixed, withClaire, none, log)).size).toBe(0);
  });

  it('spends another round only when the caller\'s deadline has room for it (PR-278 review)', async () => {
    // Two rounds a line and then a rewritten echo is four writer-plus-judge pairs — 140s
    // against a 120s Lambda, on calls that were each valid and slow.
    const retry = answering({ Gab: ['Faux.', 'Faux.', 'Faux.', 'Bon.'], Delphine: ['Deux.'], Zou: ['Trois.'] }, (line) => (line === 'Faux.' ? '0: wrong' : '1'));
    expect((await generatePodiumComments(retry, group, podium, context, none, log, Date.now() - 1)).size).toBe(0);
    expect(writesFor(retry, 'Gab')).toHaveLength(CANDIDATES); // one round only
    // With room, the second round runs — the behaviour the budget must not cost.
    const roomy = answering({ Gab: ['Faux.', 'Faux.', 'Faux.', 'Bon.'], Delphine: ['Deux.'], Zou: ['Trois.'] }, (line) => (line === 'Faux.' ? '0: wrong' : '1'));
    expect((await generatePodiumComments(roomy, group, podium, context, none, log, Date.now() + 10 * ROUND_MS)).get('1')).toBe('Bon.');
    // An echoed opening is KEPT rather than rewritten when there is no room for it.
    const echoing = answering({ Gab: ['Pas mal pour un jeudi.'], Delphine: ['Pas mal, à 4.'], Zou: ['Trois.'] });
    const kept = await generatePodiumComments(echoing, group, podium, context, none, log, Date.now() + ROUND_MS);
    expect(kept.get('2')).toBe('Pas mal, à 4.');
  });

  it('keeps comments plain text', () => {
    expect(sanitizeComment(' *La* _brigade_\n antidopage. ')).toBe('La brigade antidopage.');
    expect(sanitizeComment('"Quoted."')).toBe('Quoted.');
    expect(sanitizeComment('Wow un sous-marin !')).toBe('Wow un sous-marin !');
    expect(sanitizeComment(42)).toBeNull();
  });

  it('publishes ONLY a finished answer, whatever cut it short', async () => {
    const rest = { Delphine: [{ text: 'Deux.', finish: 'stop' as const }], Zou: [{ text: 'Trois.', finish: 'stop' as const }] };
    const truncated = answering({ Gab: [{ text: 'Ton meilleur', finish: 'length' }, { text: 'Ton meilleur des 14 jours.', finish: 'stop' }], ...rest });
    expect((await generatePodiumComments(truncated, group, podium, context, none, log)).get('1')).toBe('Ton meilleur des 14 jours.');
    const interrupted = answering({ Gab: [{ text: 'Ton meilleur', finish: 'other' }, { text: 'Ton meilleur des 14 jours.', finish: 'stop' }], ...rest });
    expect((await generatePodiumComments(interrupted, group, podium, context, none, log)).get('1')).toBe('Ton meilleur des 14 jours.');
    // Unfinished on every candidate is no comment — and so no comments at all.
    const never = answering({
      Gab: Array.from({ length: CANDIDATES * 2 }, (_, i) => ({ text: 'Ton meilleur', finish: i % 2 ? ('other' as const) : ('length' as const) })),
      ...rest,
    });
    expect((await generatePodiumComments(never, group, podium, context, none, log)).size).toBe(0);
  });

  it('an unavailable provider degrades to no comments; an empty podium costs no call', async () => {
    const err = () => new LlmUnavailable('503');
    const down = answering({ Gab: Array.from({ length: CANDIDATES * 2 }, err), Delphine: Array.from({ length: CANDIDATES * 2 }, err), Zou: Array.from({ length: CANDIDATES * 2 }, err) });
    expect((await generatePodiumComments(down, group, podium, context, none, log)).size).toBe(0);
    const empty = answering({});
    const spy = vi.spyOn(empty, 'generate');
    await generatePodiumComments(empty, group, { ...podium, lines: [] }, context, none, log);
    expect(spy).not.toHaveBeenCalled();
  });

  it('THE JUDGE DECIDES: the first kept candidate, or the first when it never answered', async () => {
    const picky = answering(
      { Gab: ['Faux.', 'Ton meilleur des 14 jours.', 'Bravo.'], Delphine: ['Deux.'], Zou: ['Trois.'] },
      (line) => (line === 'Faux.' || line === 'Bravo.' ? '0' : '1'),
    );
    expect((await generatePodiumComments(picky, group, podium, context, none, log)).get('1')).toBe('Ton meilleur des 14 jours.');
    // No verdict at all — the judge down — posts the first candidate unjudged, so an
    // outage of the judge does not blank every podium it lasts through.
    const down = answering({ Gab: ['Un phare dans la brume.', 'Bravo.'], Delphine: ['Deux.'], Zou: ['Trois.'] }, () => new LlmUnavailable('503'));
    expect((await generatePodiumComments(down, group, podium, context, none, log)).get('1')).toBe('Un phare dans la brume.');
  });
});
