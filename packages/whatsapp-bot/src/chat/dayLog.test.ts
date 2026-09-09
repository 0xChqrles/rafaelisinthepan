import { describe, expect, it, vi } from 'vitest';
import { PutItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { dayNumber } from '@whippin/shared';
import { withoutShares } from '../domain/share';
import {
  DAY_LOG_TTL_SECONDS,
  DAY_MAX_CHARS,
  DayLog,
  QUOTE_MAX_CHARS,
  TURN_MAX_CHARS,
  boundTurnText,
  clockIn,
  dayLogSortKey,
  dayOfInstant,
  dynamoDayLogStore,
  memoryDayLogStore,
  quoteLead,
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

describe('what a share message contributes (#236)', () => {
  // THE WEB'S OWN OUTPUT, verbatim (`web/src/game/share.ts` `shareText` / `wordShareText`,
  // run against the real codec): a headline, the run as emoji, a blank line, the link. The
  // bot cannot import the web, so the shape it strips is pinned here against what the web
  // actually sends.
  const SENTENCE = `Whippin AI 2026-09-03 — 7 essais\n🟥🟨1️⃣2️⃣3️⃣\n\n${ORIGIN}/s/ZBXY-GMSYiy-73w`;
  const CAPPED = `Whippin AI 2026-09-03 — ∞ essais\n🟥🟥🟨\n\n${ORIGIN}/s/ZBXefoGN______-A`;
  const WORD = `Whippin AI 2026-09-03 — 12 mots\n\nPHARE\n⚪7 🟢3 🔵1 🩷1\n\n${ORIGIN}/s/VBXZ8sYDBXBoYXJl`;

  it('drops the WHOLE generated share — headline, row and link — not only the link', () => {
    // The link is what the bot reads a share from, but the block beside it spells the
    // same result out in words and emoji. "A score-only share never reaches the provider"
    // holds only if none of it is remembered: a message that was only a share is EMPTY.
    for (const share of [SENTENCE, CAPPED, WORD]) {
      expect(withoutShares(share, ORIGIN)).toBe('');
    }
  });

  it('keeps what the player typed around the share — the commentary is the conversation', () => {
    expect(withoutShares(`gg\n${SENTENCE}`, ORIGIN)).toBe('gg');
    expect(withoutShares(`${SENTENCE}\ntrop dur aujourd'hui`, ORIGIN)).toBe("trop dur aujourd'hui");
    expect(withoutShares(`bon\n${WORD}\nqui fait mieux ?`, ORIGIN)).toBe('bon qui fait mieux ?');
    // Two shares in one message, words between them.
    expect(withoutShares(`hier\n${SENTENCE}\net aujourd'hui\n${CAPPED}`, ORIGIN)).toBe("hier et aujourd'hui");
  });

  it('strips the token whether the message was addressed to the bot or not', () => {
    const addressed = `gg 7 essais ${ORIGIN}/s/ZBXg-ISaks2-fA @WhippinBot qui mène ?`;
    const stripped = withoutShares(addressed, ORIGIN);
    expect(stripped).toBe('gg 7 essais @WhippinBot qui mène ?');
    expect(stripped).not.toContain('ZBXg');
    expect(withoutShares(`${SENTENCE} @WhippinBot qui mène ?`, ORIGIN)).toBe('@WhippinBot qui mène ?');
  });

  it('drops the pieces of a share pasted apart, and nothing a person would say', () => {
    expect(withoutShares(`${ORIGIN}/s/ZBXg-ISaks2-fA`, ORIGIN)).toBe('');
    expect(withoutShares('Whippin AI 2026-09-03 — 7 essais', ORIGIN)).toBe('');
    expect(withoutShares('🟥🟨🟪🟦2️⃣', ORIGIN)).toBe('');
    expect(withoutShares('⚪7 🟢3', ORIGIN)).toBe('');
    expect(withoutShares('BRAVO', ORIGIN)).toBe('BRAVO');
    expect(withoutShares(`PHARE\n${SENTENCE}`, ORIGIN)).toBe('PHARE');
    expect(withoutShares('trop fort 🟦🟦', ORIGIN)).toBe('trop fort 🟦🟦');
    expect(withoutShares(`a ${ORIGIN}/s/AAA et ${ORIGIN}/s/BBB b`, ORIGIN)).toBe('a et b');
    expect(withoutShares('https://example.com/s/AAA', ORIGIN)).toBe('https://example.com/s/AAA');
  });
});
