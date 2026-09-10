// ONE AT A TIME, PER KEY (#277, PR-278 review). WhatsApp hands the task its messages
// CONCURRENTLY — `whatsapp/client.ts` starts a handler per message without awaiting the
// last — which is right for ingestion (a share's acknowledgement must not wait behind
// somebody else's model call) and wrong for a conversation: every handler of a burst read
// the same `Exchange`, decided against it, and wrote its own count back, so a group already
// at seven unasked answers could produce five more and each store eight. The budget is a
// budget only if the read, the model call and the write back are ONE section — and a
// second answer that cannot see the first is wrong anyway, since the bot is meant to
// answer knowing what it just said.

export type Serial = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export function serialByKey(): Serial {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    // Run either way: one piece of work that throws must not stop the queue behind it.
    const done = previous.then(work, work);
    const tail = done.catch(() => {});
    tails.set(key, tail);
    // The entry is dropped once nothing is behind it, so a task that runs for weeks does
    // not hold a settled promise per group it has ever seen.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return done;
  };
}
