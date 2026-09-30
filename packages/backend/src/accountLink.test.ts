import { describe, expect, it, vi } from 'vitest';
import { accountStakes, drainDepartures } from './accountLink';
import type { LinkStore } from './linkStore';
import { memoryGroupStore } from './memoryGroupStore';
import { memoryHistoryStore } from './memoryHistoryStore';

const FROM = 'aaaaaaaaaaaaaaaa';
const TO = 'bbbbbbbbbbbbbbbb';
const NOW = '2026-08-26T12:00:00.000Z';

// A LinkStore reduced to the job queue: what the drain reads and clears.
function queue(pending: string[]): Pick<LinkStore, 'pendingDepartures' | 'clearDeparture'> {
  return {
    async pendingDepartures() {
      return [...pending];
    },
    async clearDeparture(_accountId, from) {
      pending.splice(pending.indexOf(from), 1);
    },
  };
}

// CONTRACT (#271): a deleted account LEAVES EVERY GROUP — its memberships are dropped, never
// carried onto the adopting account — through a durable job drained after the commit.
describe('drainDepartures', () => {
  it('drops the deleted account from every group it was in and clears the job', async () => {
    const groups = memoryGroupStore();
    await groups.create({ id: 'cccccccccccccccc', name: 'One', createdBy: FROM, now: NOW });
    await groups.create({ id: 'dddddddddddddddd', name: 'Two', createdBy: TO, now: NOW });
    await groups.join({ id: 'dddddddddddddddd', publicId: FROM, now: NOW });
    const pending = [FROM];

    await expect(drainDepartures(queue(pending) as LinkStore, groups, TO)).resolves.toBe(true);

    await expect(groups.listMine(FROM)).resolves.toEqual([]);
    expect((await groups.members('dddddddddddddddd')).map((m) => m.publicId)).toEqual([TO]);
    // Their leaving EMPTIED the group they owned alone, so it is deleted: its link 404s.
    await expect(groups.get('cccccccccccccccc')).resolves.toBeNull();
    expect(pending).toEqual([]);
  });

  it('reports a failure and leaves the job queued rather than throwing', async () => {
    const groups = memoryGroupStore();
    vi.spyOn(groups, 'leaveAll').mockRejectedValueOnce(new Error('throttled'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = [FROM];
    await expect(drainDepartures(queue(pending) as LinkStore, groups, TO)).resolves.toBe(false);
    expect(pending).toEqual([FROM]);
    warn.mockRestore();
  });

  it('is done when nothing is queued', async () => {
    await expect(drainDepartures(queue([]) as LinkStore, memoryGroupStore(), TO)).resolves.toBe(true);
  });
});

// CONTRACT (root AGENTS.md, the account's THREE NUMBERS): ONE aggregation over the
// per-language solved-day collections — `streak` is the MAXIMUM of the per-language live
// streaks, `best` the MAXIMUM of the per-language best streaks, `days` the SUM of the
// collections' sizes. Never a sum of streaks: a streak is a run of days in ONE language.
describe('accountStakes', () => {
  const ACTIVE_DAY = 20700;

  it('takes the MAXIMUM streak and the MAXIMUM best across languages, and SUMS the days', async () => {
    const history = memoryHistoryStore();
    // fr holds the live streak: three days running, up to the active day.
    const fr = [ACTIVE_DAY - 2, ACTIVE_DAY - 1, ACTIVE_DAY];
    // en holds the record: a live run of two, and an old broken run of four.
    const en = [ACTIVE_DAY - 13, ACTIVE_DAY - 12, ACTIVE_DAY - 11, ACTIVE_DAY - 10, ACTIVE_DAY - 1, ACTIVE_DAY];
    for (const day of fr) await history.recordSolvedDay({ publicId: TO, lang: 'fr', day });
    for (const day of en) await history.recordSolvedDay({ publicId: TO, lang: 'en', day });

    await expect(accountStakes(history, TO, ACTIVE_DAY)).resolves.toEqual({
      streak: 3, // fr's, not 3 + 2
      best: 4, // en's, not 3 + 4
      days: 9, // 3 + 6: a day played in either language is a day played
    });
  });
});
