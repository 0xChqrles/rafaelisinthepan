import { describe, expect, it } from 'vitest';
import { memoryOutbound } from './sqs';

const GROUP = '120363000000000001@g.us';
const command = { id: `podium:${GROUP}:20700`, kind: 'message' as const, group: GROUP, text: 'x' };

describe('the in-process outbound queue (local dry runs)', () => {
  it('redelivers what was received and never settled — the deferred command survives', async () => {
    const queue = memoryOutbound();
    await queue.enqueue(command);
    const first = await queue.receive();
    expect(first).toHaveLength(1);
    // Deferred because the socket was closed: nothing settled it, so it comes back.
    const again = await queue.receive();
    expect(again.map((m) => m.body)).toEqual(first.map((m) => m.body));
    await queue.settle(first[0].receipt);
    expect(await queue.receive()).toEqual([]);
  }, 10_000);

  it('a deferred command stays hidden for its window, then comes back', async () => {
    const queue = memoryOutbound();
    await queue.enqueue(command);
    const [first] = await queue.receive();
    await queue.defer(first.receipt, 0.8);
    expect(await queue.receive()).toEqual([]); // ~500ms in: still hidden
    expect((await queue.receive()).map((m) => m.body)).toEqual([first.body]); // ~1s: back
  }, 10_000);
});
