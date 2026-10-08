import { describe, expect, it, vi } from 'vitest';
import { PutItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { dayNumber, progressEmoji, shareHeadline } from '@whippin/shared';
import { withoutShares } from '../domain/share';
import {
  DAY_LOG_TTL_SECONDS,
  DAY_MAX_CHARS,
  DayLog,
  QUOTE_MAX_CHARS,
  TURN_MAX_CHARS,
  boundTurnText,
  clockIn,
  composeTurnText,
  dayLogSortKey,
  dayOfInstant,
  dynamoDayLogStore,
  memoryDayLogStore,
  quoteLead,
  sentIn,
  renderDay,
  type Turn,
} from './dayLog';

const GROUP = '120363000000000001@g.us';
const ORIGIN = 'https://whippin.ai';
const DAY = dayNumber('2026-09-03');
const NOON = Date.parse('2026-09-03T12:00:00Z'); // 14:00 in Paris, 08:00 in New York: still 2026-09-03
const said = (id: string, text: string, at = NOON, over: Partial<Turn> = {}): Turn => ({ group: GROUP, day: DAY, at, id, kind: 'said', name: 'Gab', text, ...over });

describe('the day log (#277)', () => {
  it('holds the day, in order, and reloads it from the store on boot', async () => {
    const store = memoryDayLogStore();
    const log = new DayLog(store);
    await log.append(said('B', 'deuxième', NOON + 1_000));
    await log.append(said('A', 'premier'));
    await log.append({ ...said('R', '❤️', NOON + 2_000), kind: 'reacted', name: '' });
    expect(log.today(GROUP, DAY).map((t) => t.text)).toEqual(['premier', 'deuxième', '❤️']);
    // The store has every row; a fresh task reads them back in the same order.
    const again = new DayLog(store);
    expect(await again.load(GROUP, DAY)).toBe(3);
    expect(again.today(GROUP, DAY).map((t) => t.id)).toEqual(['A', 'B', 'R']);
    // A row loaded twice, or appended twice (a retried call), stands once.
    await again.load(GROUP, DAY);
    await again.append(said('A', 'premier'));
    expect(again.today(GROUP, DAY)).toHaveLength(3);
  });

  it('keeps groups and days apart: today is today, and the day flips at 22:00 Eastern', async () => {
    const log = new DayLog(memoryDayLogStore());
    await log.append(said('A', 'ici'));
    await log.append({ ...said('Y', 'hier', NOON - 24 * 3_600_000), day: DAY - 1 });
    expect(log.today(GROUP, DAY).map((t) => t.text)).toEqual(['ici']);
    expect(log.today(GROUP, DAY - 1).map((t) => t.text)).toEqual(['hier']);
    expect(log.today('120363000000000002@g.us', DAY)).toEqual([]);
    // The Whippin day of an instant (the shared contract): 02:30 UTC on the 4th is 22:30 ET
    // on the 3rd, which is already the 4th's puzzle.
    expect(dayOfInstant(NOON)).toBe(DAY);
    expect(dayOfInstant(Date.parse('2026-09-04T02:30:00Z'))).toBe(DAY + 1);
    expect(dayOfInstant(Date.parse('2026-09-04T01:30:00Z'))).toBe(DAY);
  });

  it("remembers the bot's echoed line once: composed here already, it is not repeated; the podium enters", async () => {
    const log = new DayLog(memoryDayLogStore());
    // Composed with a line break, echoed back with its whitespace collapsed: the same line.
    await log.append({ ...said('M1#reply', 'Sept,\nderrière Zou.'), kind: 'bot', name: '' });
    await log.appendUnlessSaid({ ...said('W1', 'Sept, derrière Zou.', NOON + 1), kind: 'bot', name: '' });
    await log.appendUnlessSaid({ ...said('W2', 'Podium du jour', NOON + 2), kind: 'bot', name: '' });
    expect(log.today(GROUP, DAY).map((t) => t.text)).toEqual(['Sept,\nderrière Zou.', 'Podium du jour']);
  });

  it('recognises the echo of a line that was CUT on the way in, whitespace runs and all', async () => {
    // A long answer is remembered cut from the text as written; its echo arrives collapsed.
    // With a space beside a newline the two cuts land on different characters, and an
    // exact comparison would remember the line twice.
    const composed = Array.from({ length: 16 }, (_, i) => `Phrase numéro ${i} de la réponse, assez longue.`).join(' \n');
    expect(composed.length).toBeGreaterThan(TURN_MAX_CHARS);
    const log = new DayLog(memoryDayLogStore());
    await log.append({ ...said('M1#reply', composed), kind: 'bot', name: '' });
    await log.appendUnlessSaid({ ...said('W1', composed.replace(/\s+/g, ' '), NOON + 1), kind: 'bot', name: '' });
    expect(log.today(GROUP, DAY).map((t) => t.id)).toEqual(['M1#reply']);
    // Another long line is another line: only the one already said is skipped.
    await log.appendUnlessSaid({ ...said('W2', composed.replace(/\s+/g, ' ').replace('numéro 0', 'numéro zéro'), NOON + 2), kind: 'bot', name: '' });
    expect(log.today(GROUP, DAY).map((t) => t.id)).toEqual(['M1#reply', 'W2']);
  });

  it('recognises that echo wherever the cut lands, on a letter or on the whitespace it trims', async () => {
    const lines = Array.from({ length: 16 }, (_, i) => `Phrase numéro ${i} de la réponse, assez longue.`).join(' \n');
    for (let pad = 0; pad < 60; pad += 1) {
      const composed = `${'a'.repeat(pad)} ${lines}`;
      const log = new DayLog(memoryDayLogStore());
      await log.append({ ...said('M1#reply', composed), kind: 'bot', name: '' });
      await log.appendUnlessSaid({ ...said('W1', composed.replace(/\s+/g, ' ').trim(), NOON + 1), kind: 'bot', name: '' });
      expect(log.today(GROUP, DAY).map((t) => t.id), `pad ${pad}`).toEqual(['M1#reply']);
    }
    // A short line that merely ends on an ellipsis is no cut line: it swallows nothing.
    const log = new DayLog(memoryDayLogStore());
    await log.append({ ...said('M2#reply', 'Oui…'), kind: 'bot', name: '' });
    await log.appendUnlessSaid({ ...said('W3', 'Oui, le podium du jour', NOON + 1), kind: 'bot', name: '' });
    expect(log.today(GROUP, DAY).map((t) => t.id)).toEqual(['M2#reply', 'W3']);
  });

  it('skips an echo of a line already said TODAY, and never of yesterday\'s (PR-278 review)', async () => {
    // Two days are held in memory and the morning reminder is deterministic, so yesterday's
    // identical line made today's echo look like a duplicate and today lost its reminder.
    const log = new DayLog(memoryDayLogStore());
    const reminder = 'Le Whippin du jour est en ligne. Podium à 22h30.';
    await log.append({ ...said('Y', reminder, NOON - 24 * 3_600_000), day: DAY - 1, kind: 'bot', name: '' });
    await log.appendUnlessSaid({ ...said('T', reminder), kind: 'bot', name: '' });
    expect(log.today(GROUP, DAY).map((t) => t.text)).toEqual([reminder]);
    // Within the day it still holds: the same line twice is one turn.
    await log.appendUnlessSaid({ ...said('T2', reminder, NOON + 1_000), kind: 'bot', name: '' });
    expect(log.today(GROUP, DAY)).toHaveLength(1);
  });

  it('is bounded in text: a turn is cut on the way in, and a day hands out the newest turns that fit', async () => {
    const log = new DayLog(memoryDayLogStore());
    await log.append(said('X', 'x'.repeat(TURN_MAX_CHARS * 3)));
    const [turn] = log.today(GROUP, DAY);
    expect(turn.text).toHaveLength(TURN_MAX_CHARS);
    expect(turn.text.endsWith('…')).toBe(true);
    expect(boundTurnText('court')).toBe('court');
    // A hundred near-maximal turns overshoot the day's budget; the morning falls off.
    const long = new DayLog(memoryDayLogStore());
    for (let i = 0; i < 100; i += 1) await long.append(said(`T${String(i).padStart(3, '0')}`, `${i}:${'x'.repeat(TURN_MAX_CHARS - 4)}`, NOON + i));
    const kept = long.today(GROUP, DAY);
    expect(kept.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(DAY_MAX_CHARS);
    expect(kept.at(-1)?.text.startsWith('99:')).toBe(true);
    expect(kept[0].text.startsWith(`${100 - kept.length}:`)).toBe(true);
  });

  it('spells a quote out at the head of a turn, bounded, and names the author of a wordless one', () => {
    expect(quoteLead('you', 'Podium du jour')).toBe('[replying to you: "Podium du jour"] ');
    expect(quoteLead('Zou', '')).toBe('[replying to a message from Zou] ');
    const long = quoteLead('Zou', 'x'.repeat(QUOTE_MAX_CHARS + 50));
    expect(long.length).toBeLessThan(QUOTE_MAX_CHARS + 30);
    expect(long.endsWith('…"] ')).toBe(true);
  });

  it("dates a quote when its sending is known, in the group's own zone", () => {
    const sent = sentIn('Europe/Paris', NOON);
    expect(sent).toMatch(/^Thu,? 3 Sept? 2026,? 14:00$/);
    expect(quoteLead('you', "j'ai jamais dit ça", sent)).toBe(`[replying to you, sent ${sent}: "j'ai jamais dit ça"] `);
    expect(quoteLead('Zou', '', sent)).toBe(`[replying to a message from Zou, sent ${sent}] `);
    expect(composeTurnText('si', { author: 'you', text: 'A', sent }, new Map())).toBe(`[replying to you, sent ${sent}: "A"] si`);
  });

  it("renders a day with the group's own clock, the bot by its name, and a reaction in its answer form", () => {
    expect(clockIn('Europe/Paris', NOON)).toBe('14:00');
    expect(clockIn('America/New_York', NOON)).toBe('08:00');
    const turns: Turn[] = [
      said('A', 'salut'),
      { ...said('A#reply', 'salut Gab', NOON + 60_000), kind: 'bot', name: '' },
      { ...said('B#react', '❤️', NOON + 120_000), kind: 'reacted', name: '' },
    ];
    expect(renderDay(turns, 'Europe/Paris', 'WhippinBot')).toBe('[14:00] Gab: salut\n[14:01] WhippinBot: salut Gab\n[14:02] WhippinBot: REACT ❤️');
  });

  it('is stored one row per turn, ordered by day then instant, expiring in 48 hours', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const store = dynamoDayLogStore({ send } as unknown as DynamoDBClient, 'bot');
    await store.append(said('A', 'salut'));
    const put = (send.mock.calls[0] as unknown[])[0] as PutItemCommand;
    expect(put.input.Item?.pk).toEqual({ S: `DAYLOG#${GROUP}` });
    expect(put.input.Item?.sk).toEqual({ S: dayLogSortKey(DAY, NOON, 'A') });
    expect(dayLogSortKey(DAY, NOON, 'A')).toBe(`DAY#0${DAY}#${String(NOON).padStart(13, '0')}#A`);
    expect(put.input.Item?.expiresAt).toEqual({ N: String(Math.floor(NOON / 1000) + DAY_LOG_TTL_SECONDS) });
    expect(put.input.Item?.text).toEqual({ S: 'salut' });
    await store.read(GROUP, DAY);
    const query = (send.mock.calls[1] as unknown[])[0] as QueryCommand;
    expect(query.input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :day)');
    expect(query.input.ExpressionAttributeValues?.[':day']).toEqual({ S: `DAY#0${DAY}#` });
  });
});

describe('what a message becomes as a turn (#277)', () => {
  // The generated share as the web sends it (the fixtures of `domain/share.test.ts`).
  const SHARE = `${shareHeadline({ dayNumber: DAY }, 7, 'essais')}\n${progressEmoji(0)}${progressEmoji(100)}1️⃣\n\n${ORIGIN}/s/ZBXY-GMSYiy-73w`;
  const names = new Map([['33600000000', 'Zou']]);

  it('spells the quote out, names every mention, and carries nothing of a share or a number', () => {
    // Each text has its share block taken out ONCE, by the caller, as `main.ts` and
    // `diarySeed.ts` do; the composition is what the day log then keeps.
    const body = withoutShares(`${SHARE}\n@33600000000 t'as vu ?`, ORIGIN);
    const quoted = { author: 'Gab', text: withoutShares(`gg @33659018262\n${SHARE}`, ORIGIN) };
    const turn = composeTurnText(body, quoted, names)!;
    expect(turn).toBe(`[replying to Gab: "gg …8262"] Zou t'as vu ?`);
    for (const leak of ['ZBXY', 'Whippin AI', 'essais', '33600000000', '33659018262', '@']) expect(turn).not.toContain(leak);
  });

  it('keeps nothing of a message that was only a share, unless it answers something', () => {
    const onlyShare = withoutShares(SHARE, ORIGIN);
    expect(composeTurnText(onlyShare, null, names)).toBeNull();
    // Under a quote the turn still says what it answers — the bot's own line as "you".
    expect(composeTurnText(onlyShare, { author: 'you', text: 'Podium du jour' }, names)).toBe('[replying to you: "Podium du jour"]');
    expect(composeTurnText('oui', null, names)).toBe('oui');
  });
});
