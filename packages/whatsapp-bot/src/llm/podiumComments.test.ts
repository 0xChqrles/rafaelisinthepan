import { describe, expect, it, vi } from 'vitest';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import { LINE_RULES, lineRules, dropEchoes, generatePodiumComments, namesSomebody, podiumCommentLines, readsLikeASimile, sanitizeComment, spellsANumber } from './podiumComments';

// The user turn is the FACTS as JSON, then the rules a line is checked against.
function factsIn(content: string) {
  const [facts, rules] = content.split('\n');
  expect(rules).toMatch(/ Move [123]\.$/);
  expect(rules.startsWith(LINE_RULES)).toBe(true);
  return JSON.parse(facts);
}
import { LlmUnavailable, type LlmProvider, type LlmResponse } from './types';

const podium = {
  dayNumber: 20700,
  lines: [
    { position: 1, score: 3, players: [{ jid: 'a', name: 'Gab' }] },
    {
      position: 2,
      score: 4,
      players: [
        { jid: 'b', name: 'Delphine' },
        { jid: 'c', name: 'Zou' },
      ],
    },
  ],
  capped: [],
};
const group = parseGroupConfig('g.json', {
  id: '120363000000000001@g.us',
  name: 'g',
  language: 'fr',
  enabled: true,
  timezone: 'Europe/Paris', podium: { enabled: true, time: '22:00' },
  chat: { enabled: true, prePrompt: 'On se chambre.' },
});
const log = createLog('silent');

type Finish = 'stop' | 'length' | 'tool_calls' | 'other';
type Answer = string | Error | { text: string | null; finish: Finish };

// Answers BY LINE, never by call order: the lines are generated in parallel, so which
// request arrives second is the scheduler's business and not a thing to assert against.
function answering(byPlace: Record<number, Answer[]>): LlmProvider & {
  calls: number;
  requests: { messages: { content: string }[] }[];
} {
  const used: Record<number, number> = {};
  const provider = {
    name: 'fake',
    model: 'fake',
    calls: 0,
    requests: [] as { messages: { content: string }[] }[],
    async generate(request: { messages: { content: string }[] }): Promise<LlmResponse> {
      provider.calls += 1;
      provider.requests.push(request);
      const place = factsIn(request.messages[0].content).place as number;
      const n = (used[place] ??= 0);
      used[place] += 1;
      const next = (byPlace[place] ?? [])[n];
      if (next instanceof Error) throw next;
      const shaped = typeof next === 'object' && next !== null ? next : { text: next ?? '', finish: 'stop' as const };
      return {
        text: shaped.text,
        toolCalls: [],
        finish: shaped.finish,
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: 1,
      };
    },
  };
  return provider as unknown as LlmProvider & { calls: number; requests: { messages: { content: string }[] }[] };
}

// The payloads the provider received, BY PLACE. Arrival order is the scheduler's business —
// the lines are generated in parallel, and reading `requests` in insertion order only
// happens to work while the fake resolves synchronously.
function sentByPlace(provider: { requests: { messages: { content: string }[] }[] }) {
  return provider.requests
    .map((r) => factsIn(r.messages[0].content as string))
    .sort((a, b) => a.place - b.place);
}

describe('podium comments are prose keyed to immutable lines (#236)', () => {
  it('hands the model one line at a time, and never the id it keys the answer by', async () => {
    expect(podiumCommentLines(podium)).toEqual([
      { id: '3', position: 1, score: 3, names: ['Gab'] },
      { id: '4', position: 2, score: 4, names: ['Delphine', 'Zou'] },
    ]);
    const provider = answering({ 1: ['Brigade antidopage.'], 2: ['Duo.'] });
    const comments = await generatePodiumComments(provider, group, podium, log);
    // One call per line, and the comments come back keyed to their own lines.
    expect(provider.calls).toBe(2);
    expect(comments.get('3')).toBe('Brigade antidopage.');
    expect(comments.get('4')).toBe('Duo.');
    // Each call carries only ITS line, plus how many there were — never the whole podium,
    // and never an `id` the model could echo back as prose.
    const sent = sentByPlace(provider)[0];
    // The VERDICT travels with the line, from the same thresholds the emoji uses. Without
    // it the model cannot tell whether 10 is good and invents something that merely sounds
    // like a comment — the observed one was "le chronomètre a souffert", about a game that
    // times nothing.
    // THE SCORE ITSELF IS NOT SENT (v8): it is printed above the line, and a number the
    // model never saw is one it cannot read back.
    expect(sent).toEqual({ place: 1, who: ['Gab'], outOf: 2, verdict: 'perfect' });
    // No thinking: a deliberated line ran past the timeout under the v8 voice.
    expect((provider.requests[0] as { effort?: string }).effort).toBe('none');
    // Each line is told which of the three moves to make, since it cannot see the others.
    expect(lineRules(2)).toBe(`${LINE_RULES} Move 2.`);
    const moves = provider.requests.map((r) => r.messages[0].content.slice(-2, -1));
    expect(new Set(moves).size).toBe(2);
  });

  it('bands every podium line, so a winning score can still be an ordinary one', async () => {
    // Today's real beta podium: 10 wins the day and is `ordinary` in absolute terms. The
    // model is told both, because they are different facts.
    const wide = { ...podium, lines: [
      { ...podium.lines[0], score: 10, position: 1 },
      { ...podium.lines[1], score: 30, position: 2 },
    ] };
    const provider = answering({ 1: ['a.'], 2: ['b.'] });
    await generatePodiumComments(provider, group, wide, log);
    expect(sentByPlace(provider).map((x) => [x.place, x.verdict])).toEqual([
      [1, 'ordinary'],
      [2, 'laboured'],
    ]);
  });

  it('refuses a line that spells a number, names somebody or leans on a simile, and tries again (v8)', async () => {
    // Any digit, and any number word from three up in either language; "un/une/deux" stay,
    // being articles and "vous deux". The check is folded, so accents and case do not hide one.
    expect(spellsANumber('Trois essais, propre.')).toBe(true);
    expect(spellsANumber('un 4 sans un bruit')).toBe(true);
    expect(spellsANumber('QUATORZE coups')).toBe(true);
    expect(spellsANumber('Vingt-sept et debout.')).toBe(true);
    expect(spellsANumber('Une patience de luthier, vous deux.')).toBe(false);
    // Anywhere in the line: allowed mid-line, the name became a tic ("Tu es un tracteur, Quentin").
    expect(namesSomebody('Gab, je vais encadrer ça.', ['Gab'])).toBe(true);
    expect(namesSomebody('Tu es un tracteur, zou.', ['Delphine', 'Zou'])).toBe(true);
    expect(namesSomebody('Je vais encadrer ça.', ['Gab'])).toBe(false);
    expect(namesSomebody('Un gabarit de champion.', ['Gab'])).toBe(false); // whole words only
    // The voice declares; a simile is the lyrical move it was asked to drop.
    expect(readsLikeASimile('Tu es un tigre.')).toBe(false);
    expect(readsLikeASimile('Tu avances comme un tracteur.')).toBe(true);
    expect(readsLikeASimile('Comme si de rien.')).toBe(true);
    expect(readsLikeASimile('You are a tiger.')).toBe(false);
    expect(readsLikeASimile('Solid, like a fridge.')).toBe(true);
    expect(readsLikeASimile('I like that.')).toBe(false);
    const provider = answering({
      1: ['Trois essais, propre.', 'Je vais encadrer ça.'],
      2: ['Delphine et Zou, un duo.', 'Vous deux, un duo.'],
    });
    const comments = await generatePodiumComments(provider, group, podium, log);
    expect(comments.get('3')).toBe('Je vais encadrer ça.');
    expect(comments.get('4')).toBe('Vous deux, un duo.');
    expect(provider.calls).toBe(4);
    // Three attempts now that one costs a second; then the line goes bare.
    const stubborn = answering({ 1: ['Trois.', 'Quatre.', 'Cinq.'], 2: ['Vous deux, un duo.'] });
    expect((await generatePodiumComments(stubborn, group, podium, log)).has('3')).toBe(false);
    expect(stubborn.calls).toBe(4);
    const simile = answering({ 1: ['Un tigre, comme toujours.', 'Un tigre absolu.'], 2: ['Vous deux, un duo.'] });
    expect((await generatePodiumComments(simile, group, podium, log)).get('3')).toBe('Un tigre absolu.');
  });

  it('keeps comments plain text', () => {
    expect(sanitizeComment(' *La* _brigade_\n antidopage. ')).toBe('La brigade antidopage.');
    expect(sanitizeComment('"Quoted."')).toBe('Quoted.');
    expect(sanitizeComment(42)).toBeNull();
  });

  it('A LINE THAT FAILS NO LONGER TAKES THE OTHERS WITH IT', async () => {
    // The whole reason for one call per line: the renderer prints a podium line with no
    // comment, so a partial set is a partial podium rather than a bare one.
    const provider = answering({ 1: ['', ''], 2: ['La deuxième tient.'] });
    const comments = await generatePodiumComments(provider, group, podium, log);
    expect(comments.has('3')).toBe(false); // both attempts unusable, given up on
    expect(comments.get('4')).toBe('La deuxième tient.');
  });

  it('publishes ONLY a finished answer, whatever cut it short', async () => {
    // The budget is shared with this model's reasoning, so running out returns a fragment.
    const truncated = answering({
      1: [{ text: 'Brigade anti', finish: 'length' }, { text: 'Brigade antidopage.', finish: 'stop' }],
      2: [{ text: 'Duo.', finish: 'stop' }],
    });
    expect((await generatePodiumComments(truncated, group, podium, log)).get('3')).toBe('Brigade antidopage.');

    // And `length` is not the only early stop: DeepSeek's `insufficient_system_resource`
    // and `content_filter` both arrive as `other`, and the partial they leave behind reads
    // like an ordinary short line. Refused on the REASON, never inspected.
    const interrupted = answering({
      1: [{ text: 'Brigade anti', finish: 'other' }, { text: 'Brigade antidopage.', finish: 'stop' }],
      2: [{ text: 'Duo.', finish: 'stop' }],
    });
    expect((await generatePodiumComments(interrupted, group, podium, log)).get('3')).toBe('Brigade antidopage.');

    // Twice unfinished is a bare line, not a fragment posted to the group.
    const never = answering({
      1: [{ text: 'Brigade anti', finish: 'other' }, { text: 'Brigade anti', finish: 'length' }],
      2: [{ text: 'Duo.', finish: 'stop' }],
    });
    const comments = await generatePodiumComments(never, group, podium, log);
    expect(comments.has('3')).toBe(false);
    expect(comments.get('4')).toBe('Duo.');
  });

  it('retries an unusable answer twice per line, then leaves that line bare', async () => {
    const provider = answering({ 1: ['', '', ''], 2: ['', '', ''] });
    expect((await generatePodiumComments(provider, group, podium, log)).size).toBe(0);
    expect(provider.calls).toBe(6); // two lines, three attempts each
  });

  it('an unavailable provider degrades to no comments; a bug stops after one call per line', async () => {
    const err = () => new LlmUnavailable('503');
    const down = answering({ 1: [err(), err(), err()], 2: [err(), err(), err()] });
    expect((await generatePodiumComments(down, group, podium, log)).size).toBe(0);
    expect(down.calls).toBe(6);
    const bug = answering({ 1: [new Error('HTTP 401')], 2: [new Error('HTTP 401')] });
    expect((await generatePodiumComments(bug, group, podium, log)).size).toBe(0);
    expect(bug.calls).toBe(2); // one per line, not retried
    const empty = answering({});
    const spy = vi.spyOn(empty, 'generate');
    await generatePodiumComments(empty, group, { ...podium, lines: [] }, log);
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops a comment that echoes a distinctive word an earlier line already used', () => {
    // Written apart and in parallel, identical verdicts converge on identical prose: a real
    // podium told almost everybody they had sweated. One word, once per podium.
    const lines = [
      { id: '10', position: 1, score: 10, names: ['Delphine'] },
      { id: '17', position: 2, score: 17, names: ['Marielle Durand'] },
      { id: '21', position: 3, score: 21, names: ['Bruno', 'Gab'] },
      { id: '30', position: 4, score: 30, names: ['Christine'] },
    ];
    const { kept, dropped } = dropEchoes(
      lines,
      new Map([
        ['10', 'Tu as bien transpiré, mais tu es devant.'],
        ['17', 'Ça a transpiré aussi, Marielle.'], // "transpire" again: dropped
        ['21', "Vous avez tenu la phrase jusqu'au bout."], // game vocabulary may repeat
        ['30', 'La phrase était dure, Christine, belle journée.'], // a name is never an echo
      ]),
    );
    expect(dropped).toEqual(['17']);
    expect([...kept.keys()]).toEqual(['10', '21', '30']);
    // Accents and case do not hide an echo.
    const again = dropEchoes(lines, new Map([['10', 'Résisté, hein.'], ['17', 'Bien RESISTE aussi.']]));
    expect(again.dropped).toEqual(['17']);
  });
});
