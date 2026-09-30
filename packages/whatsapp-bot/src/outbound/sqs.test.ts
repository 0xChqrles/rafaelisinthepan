import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryOutbound } from './sqs';

const GROUP = '120363000000000001@g.us';
const command = (n: number) => ({ id: `podium:${GROUP}:${n}`, kind: 'message' as const, group: GROUP, text: 'x' });

// A poll that finds nothing sleeps 500ms before it answers: the fake clock runs that out.
async function emptyPoll(queue: ReturnType<typeof memoryOutbound>) {
  const poll = queue.receive();
  await vi.advanceTimersByTimeAsync(500);
  return poll;
}

describe('the in-process outbound queue (local dry runs)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides what was received for its visibility window, then redelivers it if never settled', async () => {
    // A dispatch that THREW (nothing settled or deferred it) comes back after the window,
    // the way SQS brings it back — not on every poll, and not never.
    const queue = memoryOutbound({ visibilitySeconds: 0.4 });
    await queue.enqueue(command(1));
    const first = await queue.receive();
    expect(first).toHaveLength(1);
    expect(await emptyPoll(queue)).toEqual([]); // hidden
    const again = await queue.receive(); // past the window: back
    expect(again.map((m) => m.body)).toEqual(first.map((m) => m.body));
    await queue.settle(first[0].receipt);
    expect(await emptyPoll(queue)).toEqual([]);
  });

  it('a deferred command stays hidden for its window, then comes back', async () => {
    const queue = memoryOutbound();
    await queue.enqueue(command(1));
    const [first] = await queue.receive();
    await queue.defer(first.receipt, 0.4);
    expect(await emptyPoll(queue)).toEqual([]); // still hidden
    expect((await queue.receive()).map((m) => m.body)).toEqual([first.body]); // back
  });

  it('never hands back more than one receive of the real queue would', async () => {
    // Seven commands, a batch of five: the two that do not fit are not lost, they are
    // simply still there on the next poll — and a backlog of REDELIVERIES obeys the same
    // ceiling, which is what capping only the fresh half used to miss.
    const queue = memoryOutbound({ visibilitySeconds: 0.4 });
    for (let n = 1; n <= 7; n += 1) await queue.enqueue(command(n));
    expect(await queue.receive()).toHaveLength(5);
    expect(await queue.receive()).toHaveLength(2); // the remainder, the five still hidden
    // Nothing is visible yet, and the empty poll is what waits the window out.
    expect(await emptyPoll(queue)).toEqual([]);
    // All seven are visible again now, and a receive STILL yields five.
    expect(await queue.receive()).toHaveLength(5);
  });

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
  });
});
