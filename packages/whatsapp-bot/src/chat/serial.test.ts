import { describe, expect, it } from 'vitest';
import { serialByKey } from './serial';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('one at a time, per key (PR-278 review)', () => {
  it('runs one key\'s work in order, and different keys at the same time', async () => {
    const serial = serialByKey();
    const order: string[] = [];
    const slow = (key: string, label: string, ms: number) =>
      serial(key, async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${label}:end`);
      });
    // Started together; A2 waits for A1, B1 does not.
    await Promise.all([slow('A', 'a1', 20), slow('A', 'a2', 1), slow('B', 'b1', 1)]);
    expect(order.indexOf('a1:end')).toBeLessThan(order.indexOf('a2:start'));
    expect(order.indexOf('b1:end')).toBeLessThan(order.indexOf('a1:end'));
  });

  it('READ, DECIDE and WRITE are one section, so a burst cannot pass a budget', async () => {
    // The bug this exists for: five handlers of one burst read the same count, all decided
    // they were under the cap, and each wrote its own value back.
    const serial = serialByKey();
    let count = 0;
    let answered = 0;
    const CAP = 8;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        serial('g', async () => {
          const seen = count; // read
          await tick(); // the model call
          if (seen >= CAP) return;
          answered += 1;
          count = seen + 1; // write
        }),
      ),
    );
    expect(count).toBe(5);
    expect(answered).toBe(5);
    // At the cap, nothing passes — however many arrive at once.
    count = CAP;
    answered = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        serial('g', async () => {
          const seen = count;
          await tick();
          if (seen >= CAP) return;
          answered += 1;
          count = seen + 1;
        }),
      ),
    );
    expect(answered).toBe(0);
    expect(count).toBe(CAP);
  });

  it('a rejection settles for its caller and does not stop the queue behind it', async () => {
    const serial = serialByKey();
    const ran: string[] = [];
    const failed = serial('g', async () => {
      ran.push('one');
      throw new Error('boom');
    });
    const after = serial('g', async () => {
      ran.push('two');
      return 'ok';
    });
    await expect(failed).rejects.toThrow('boom');
    expect(await after).toBe('ok');
    expect(ran).toEqual(['one', 'two']);
  });
});
