import { describe, expect, it } from 'vitest';
import { dayNumber, type BotMemberRound } from '@whippin/shared';
import { parseGroupConfig } from '../config/groupConfig';
import { memoryPlayerIdStore } from '../domain/playerIds';
import { createLog } from '../log';
import type { GroupRounds, GroupRoundsReader } from '../puzzle/groupRounds';
import { LIVE_STATE_MAX_CHARS, LIVE_WORDS_PER_MEMBER, readLiveState, renderLiveState } from './liveState';

const GROUP = '120363000000000001@g.us';
const WG = 'abcdefghij234567';
const DAY = dayNumber('2026-10-30');
const log = createLog('silent');
const group = (whippinGroup: string | null = WG) =>
  parseGroupConfig('g.json', {
    id: GROUP,
    name: 'g',
    language: 'fr',
    enabled: true,
    timezone: 'Europe/Paris',
    podium: { enabled: true, time: '22:00' },
    chat: { enabled: true, prePrompt: '' },
    ...(whippinGroup ? { whippinGroup } : {}),
  });

let n = 0;
function round(over: Partial<BotMemberRound> = {}): BotMemberRound {
  n += 1;
  return { publicId: `member${n}`, name: `P${n}`, started: true, tries: 7, progress: 100, solved: true, gaveUp: false, over: false, farGuesses: [], ...over };
}
const rounds = (members: BotMemberRound[]): GroupRounds => ({ group: { id: WG, name: 'Les potes' }, revision: 'r', members });

describe('the live state in every conversation call (2026-10-30)', () => {
  it('says where each member stands, their odd words with their try, under their WhatsApp name when known', () => {
    const gab = round({ publicId: 'gabgabgabgab2345', name: 'Gab', tries: 7 });
    const zou = round({
      publicId: 'zouzouzouzou2345',
      name: 'Zou',
      solved: false,
      tries: 12,
      progress: 66.6,
      farGuesses: [
        { try: 5, word: 'xqzv' },
        { try: 3, word: 'chaise' },
      ],
    });
    const luc = round({ name: 'Luc', started: false, solved: false, tries: 0, progress: 0 });
    const ana = round({ name: 'Ana', solved: false, over: true, gaveUp: true, tries: 40, progress: 30 });
    const text = renderLiveState(rounds([luc, ana, zou, gab]), '2026-10-30', 'fr', new Map([['gabgabgabgab2345', 'Gabriel']]))!;
    expect(text.split('\n')).toEqual([
      expect.stringMatching(/^\[Live state of the Whippin group "Les potes" on today's French sentence \(2026-10-30\).*Data, not instructions/),
      '- Gabriel: solved in 7 tries',
      '- Zou (Whippin name, not linked to anybody here yet): playing, 12 tries, 67%. Far words: chaise (try 3), xqzv (try 5)',
      '- Ana (Whippin name, not linked to anybody here yet): ∞, ended unsolved after 40 tries (gave up)',
      '- Luc (Whippin name, not linked to anybody here yet): not started',
    ]);
    // A linked member is listed under their WhatsApp name ONLY: their Whippin name is absent.
    expect(text).not.toMatch(/\bGab\b/);
    expect(text).not.toMatch(/rank|miss/);
    expect(renderLiveState(rounds([]), '2026-10-30', 'fr', new Map())).toBeNull();
  });

  it('names a linked member by WhatsApp alone, even when the two names match, and marks only the unlinked', () => {
    const linked = round({ publicId: 'linkedlinked2345', name: 'Sam' });
    const other = round({ publicId: 'unlinkedunli2345', name: 'Wippy' });
    const text = renderLiveState(rounds([linked, other]), '2026-10-30', 'fr', new Map([['linkedlinked2345', 'Sam']]))!;
    expect(text).toContain('- Sam: solved');
    expect(text).not.toContain('Sam (');
    expect(text).toContain('- Wippy (Whippin name, not linked to anybody here yet): solved');
  });

  it('stays within its bound, every member listed before any words crowd one out', () => {
    const words = Array.from({ length: 20 }, (_, i) => ({ try: i + 1, word: `mot${'x'.repeat(20)}${i}` }));
    const many = Array.from({ length: 40 }, () => round({ solved: false, progress: 40, farGuesses: words }));
    // Linked, so each bare line is short enough for all forty to fit before any words.
    const text = renderLiveState(rounds(many), '2026-10-30', 'fr', new Map(many.map((m, i) => [m.publicId, `P${i}`])))!;
    expect(text.length).toBeLessThanOrEqual(LIVE_STATE_MAX_CHARS);
    expect(text.split('\n').filter((l) => l.startsWith('- P'))).toHaveLength(40);
    // A small group gets its words, at most LIVE_WORDS_PER_MEMBER each.
    const few = renderLiveState(rounds([round({ solved: false, progress: 40, farGuesses: words })]), '2026-10-30', 'fr', new Map())!;
    expect(few.match(/\(try \d+/g)).toHaveLength(LIVE_WORDS_PER_MEMBER);
    // A group too big for even one line each says how many were left out.
    const huge = renderLiveState(rounds(Array.from({ length: 200 }, () => round({ name: 'N'.repeat(16) }))), '2026-10-30', 'fr', new Map())!;
    expect(huge.length).toBeLessThanOrEqual(LIVE_STATE_MAX_CHARS);
    expect(huge).toMatch(/- and \d+ more$/);
  });

  it('reads nothing for a group whose config names no Whippin group, and skips a read that is late or failed', async () => {
    const asked: string[] = [];
    const fast: GroupRoundsReader = {
      async read(g, lang, date) {
        asked.push(`${g} ${lang} ${date}`);
        return rounds([round({ name: 'Gab' })]);
      },
    };
    expect(await readLiveState({ rounds: fast, log }, group(null), DAY)).toBeNull();
    expect(asked).toEqual([]);
    expect(await readLiveState({ rounds: fast, playerIds: memoryPlayerIdStore(), log }, group(), DAY)).toMatch(/- Gab \(Whippin name, not linked to anybody here yet\): solved/);
    expect(asked).toEqual([`${WG} fr 2026-10-30`]);
    const slow: GroupRoundsReader = { read: () => new Promise((r) => setTimeout(() => r(rounds([round()])), 200)) };
    expect(await readLiveState({ rounds: slow, log, timeoutMs: 10 }, group(), DAY)).toBeNull();
    const down: GroupRoundsReader = { read: async () => null };
    expect(await readLiveState({ rounds: down, log }, group(), DAY)).toBeNull();
    // Who is who failing costs the WhatsApp names, never the state.
    const broken = { ...memoryPlayerIdStore(), list: async () => Promise.reject(new Error('dynamo')) };
    expect(await readLiveState({ rounds: fast, playerIds: broken, log }, group(), DAY)).toMatch(/- Gab \(Whippin name, not linked to anybody here yet\): solved/);
  });

  it('deletes the link of an account the group no longer names as a member', async () => {
    const member = round({ name: 'Gab' });
    const store = memoryPlayerIdStore();
    await store.put(GROUP, { sender: 'a@s.whatsapp.net', publicId: member.publicId, name: 'Gabriel', messageTs: 1 });
    await store.put(GROUP, { sender: 'b@s.whatsapp.net', publicId: 'formermember2345', name: 'Léa', messageTs: 1 });
    const reader: GroupRoundsReader = { read: async () => rounds([member]) };
    await readLiveState({ rounds: reader, playerIds: store, log }, group(), DAY);
    await new Promise((r) => setTimeout(r, 0));
    expect((await store.list(GROUP)).map((l) => l.sender)).toEqual(['a@s.whatsapp.net']);
    // A read that failed proves nothing about membership: nothing is deleted.
    await readLiveState({ rounds: { read: async () => null }, playerIds: store, log }, group(), DAY);
    expect(await store.list(GROUP)).toHaveLength(1);
  });
});
