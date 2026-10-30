import { describe, expect, it } from 'vitest';
import { dayNumber, type BotMemberRound } from '@whippin/shared';
import { parseGroupConfig } from '../config/groupConfig';
import { createLog } from '../log';
import type { GroupRounds, GroupRoundsReader } from '../puzzle/groupRounds';
import type { InboundMessage } from './message';
import { agrees, createSharerLookup, memoryPlayerIdStore, verifiedRoundsOf, whatsappNames } from './playerIds';
import type { DecodedShare } from './share';

const GROUP = '120363000000000001@g.us';
const WG = 'abcdefghij234567';
const GAB = 'gabgabgabgab2345';
const ZOU = 'zouzouzouzou2345';
const DAY = dayNumber('2026-10-30');
const log = createLog('silent');
const config = (over: Record<string, unknown> = {}) =>
  parseGroupConfig(
    'g.json',
    Object.fromEntries(
      Object.entries({
        id: GROUP,
        name: 'g',
        language: 'fr',
        enabled: true,
        timezone: 'Europe/Paris',
        podium: { enabled: true, time: '22:00' },
        chat: { enabled: true, prePrompt: '' },
        whippinGroup: WG,
        ...over,
      }).filter(([, v]) => v !== undefined),
    ),
  );

function round(publicId: string, over: Partial<BotMemberRound> = {}): BotMemberRound {
  return { publicId, name: publicId.slice(0, 3), started: true, tries: 7, progress: 100, solved: true, gaveUp: false, over: false, farGuesses: [], ...over };
}

function reader(members: BotMemberRound[] | null) {
  const asked: string[] = [];
  const rounds: GroupRoundsReader = {
    async read(group, lang, date, options) {
      asked.push(`${group} ${lang} ${date}${options?.fresh ? ' fresh' : ''}`);
      return members ? ({ group: { id: WG, name: 'Les potes' }, revision: 'r', members } satisfies GroupRounds) : null;
    },
  };
  return { rounds, asked };
}

const share = (over: Partial<DecodedShare> = {}): DecodedShare => ({ token: 't', lang: 'fr', dayNumber: DAY, score: 7, capped: false, ...over });
const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  group: GROUP,
  id: 'M1',
  sender: '33612345678@s.whatsapp.net',
  senderName: 'Gabriel',
  text: '',
  timestamp: 1000,
  fromMe: false,
  participant: '33612345678@s.whatsapp.net',
  mentions: [],
  live: true,
  ...over,
});

describe('who is who: a signed share, verified against the Whippin group\'s rounds (2026-10-30)', () => {
  it('a round agrees with a token when it solved in exactly its tries, or ended unsolved for a ∞ token', () => {
    expect(agrees(round(GAB), { score: 7, capped: false })).toBe(true);
    expect(agrees(round(GAB), { score: 8, capped: false })).toBe(false);
    expect(agrees(round(GAB, { solved: false, progress: 60 }), { score: 7, capped: false })).toBe(false);
    expect(agrees(round(GAB, { solved: false, over: true, gaveUp: true }), { score: 0, capped: true })).toBe(true);
    expect(agrees(round(GAB), { score: 0, capped: true })).toBe(false);
  });

  it('links the sender only when the id is a member AND their round matches the token', async () => {
    const store = memoryPlayerIdStore();
    const { rounds, asked } = reader([round(GAB), round(ZOU, { tries: 12 })]);
    const lookup = createSharerLookup({ rounds, playerIds: store, log });
    // The share's own (language, day) is the read asked for.
    expect(await lookup(config(), share({ publicId: GAB }), message())).toMatchObject({ publicId: GAB });
    // FRESH: the round a share is about has just ended, and a held answer predates it.
    expect(asked).toEqual([`${WG} fr 2026-10-30 fresh`]);
    expect(await store.get(GROUP, message().sender)).toEqual({ sender: message().sender, publicId: GAB, name: 'Gabriel', messageTs: 1000 });
    // Not a member, a round saying something else, a forwarded result: nothing stored.
    const other = '33699999999@s.whatsapp.net';
    expect(await lookup(config(), share({ publicId: 'nobodynobody2345' }), message({ sender: other }))).toBeNull();
    expect(await lookup(config(), share({ publicId: ZOU }), message({ sender: other }))).toBeNull();
    expect(await lookup(config(), share({ publicId: ZOU, score: 12 }), message({ sender: other, forwarded: true }))).toBeNull();
    expect(await store.get(GROUP, other)).toBeNull();
  });

  it('the LATEST verified share wins, and an unsigned share is read through the stored link', async () => {
    const store = memoryPlayerIdStore();
    const lookup = createSharerLookup({ rounds: reader([round(GAB), round(ZOU)]).rounds, playerIds: store, log });
    await lookup(config(), share({ publicId: ZOU }), message({ timestamp: 2000 }));
    await lookup(config(), share({ publicId: GAB }), message({ timestamp: 1000 })); // an older message, replayed
    expect((await store.get(GROUP, message().sender))?.publicId).toBe(ZOU);
    // Unsigned: the stored account's round, when it matches this token.
    expect(await lookup(config(), share(), message())).toMatchObject({ publicId: ZOU });
    expect(await lookup(config(), share({ score: 9 }), message())).toBeNull();
    expect(await lookup(config(), share(), message({ sender: 'unknown@s.whatsapp.net' }))).toBeNull();
  });

  it('reads nothing for a group whose config names no Whippin group, and nothing comes of a failed read', async () => {
    const { rounds, asked } = reader([round(GAB)]);
    const lookup = createSharerLookup({ rounds, playerIds: memoryPlayerIdStore(), log });
    expect(await lookup(config({ whippinGroup: undefined }), share({ publicId: GAB }), message())).toBeNull();
    expect(asked).toEqual([]);
    const down = createSharerLookup({ rounds: reader(null).rounds, playerIds: memoryPlayerIdStore(), log });
    expect(await down(config(), share({ publicId: GAB }), message())).toBeNull();
  });

  it('names an account by its WhatsApp member, the latest link winning, the operator override first', () => {
    const g = config({ names: { '33622222222@s.whatsapp.net': 'Bibi' } });
    const names = whatsappNames(g, [
      { sender: '33611111111@s.whatsapp.net', publicId: GAB, name: 'Old phone', messageTs: 1 },
      { sender: '33633333333@s.whatsapp.net', publicId: GAB, name: 'Gabriel', messageTs: 5 },
      { sender: '33622222222@s.whatsapp.net', publicId: ZOU, name: 'Zoé', messageTs: 2 },
    ]);
    expect(names).toEqual(new Map([[GAB, 'Gabriel'], [ZOU, 'Bibi']]));
  });

  it('finds the podium\'s verified posters: linked, and their round agreeing with what they posted', async () => {
    const store = memoryPlayerIdStore();
    await store.put(GROUP, { sender: 'gab', publicId: GAB, name: 'Gabriel', messageTs: 1 });
    await store.put(GROUP, { sender: 'zou', publicId: ZOU, name: 'Zoé', messageTs: 1 });
    const deps = { rounds: reader([round(GAB), round(ZOU, { tries: 9 })]).rounds, playerIds: store, log };
    const posted = [
      { sender: 'gab', score: 7, capped: false },
      { sender: 'zou', score: 8, capped: false }, // their round says 9
      { sender: 'luc', score: 5, capped: false }, // never linked
    ];
    expect([...(await verifiedRoundsOf(deps, config(), 'fr', DAY, posted)).keys()]).toEqual(['gab']);
    expect((await verifiedRoundsOf(deps, config({ whippinGroup: undefined }), 'fr', DAY, posted)).size).toBe(0);
  });
});
