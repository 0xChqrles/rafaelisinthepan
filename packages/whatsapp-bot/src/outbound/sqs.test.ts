import { describe, expect, it } from 'vitest';
import { memoryOutbound } from './sqs';

const GROUP = '120363000000000001@g.us';
const command = (n: number) => ({ id: `podium:${GROUP}:${n}`, kind: 'message' as const, group: GROUP, text: 'x' });

describe('the in-process outbound queue (local dry runs)', () => {
  it('hides what was received for its visibility window, then redelivers it if never settled', async () => {
    // A dispatch that THREW (nothing settled or deferred it) comes back after the window,
    // the way SQS brings it back — not on every poll, and not never.
    const queue = memoryOutbound({ visibilitySeconds: 0.4 });
    await queue.enqueue(command(1));
    const first = await queue.receive();
    expect(first).toHaveLength(1);
    expect(await queue.receive()).toEqual([]); // hidden (the idle wait runs ~500ms)
    const again = await queue.receive(); // past the window: back
    expect(again.map((m) => m.body)).toEqual(first.map((m) => m.body));
    await queue.settle(first[0].receipt);
    expect(await queue.receive()).toEqual([]);
  }, 10_000);

  it('a deferred command stays hidden for its window, then comes back', async () => {
    const queue = memoryOutbound();
    await queue.enqueue(command(1));
    const [first] = await queue.receive();
    await queue.defer(first.receipt, 0.4);
    expect(await queue.receive()).toEqual([]); // still hidden; the idle wait runs ~500ms
    expect((await queue.receive()).map((m) => m.body)).toEqual([first.body]); // back
  }, 10_000);

  it('what is pending is delivered while an earlier message is still in flight', async () => {
    // The socket dropped for one command, which is deferred for minutes: the reaction
    // queued a second later must not wait those minutes out behind it.
    const queue = memoryOutbound();
    await queue.enqueue(command(1));
    const [deferred] = await queue.receive();
    await queue.defer(deferred.receipt, 300);
    await queue.enqueue(command(2));
    await queue.enqueue(command(3));
    const next = await queue.receive();
    expect(next.map((m) => JSON.parse(m.body).id)).toEqual([`podium:${GROUP}:2`, `podium:${GROUP}:3`]);
  }, 10_000);
});
