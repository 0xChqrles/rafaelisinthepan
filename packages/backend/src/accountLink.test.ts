import { describe, expect, it, vi } from 'vitest';
import { drainDepartures } from './accountLink';
import type { LinkStore } from './linkStore';
import { memoryGroupStore } from './memoryGroupStore';

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
    // The creator's own group survives them, empty: its link still joins.
    expect(await groups.members('cccccccccccccccc')).toEqual([]);
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
