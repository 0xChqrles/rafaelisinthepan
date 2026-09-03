// The outbound queue's transport. A producer sends one command per SQS message; the
// consumer long-polls, hands each body to the dispatcher, and deletes the message only on a
// settled outcome (sent, already sent, or unsendable by construction). A transient failure
// leaves the message to reappear after its visibility timeout — SQS's own retry.

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { OutboundCommand, OutboundQueue } from './commands';

export function sqsOutboundQueue(client: SQSClient, queueUrl: string): OutboundQueue {
  return {
    async enqueue(command) {
      await client.send(
        new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(command) }),
      );
    },
  };
}

export interface QueuedBody {
  body: string;
  receipt: string;
}

export interface CommandSource {
  receive(): Promise<QueuedBody[]>;
  settle(receipt: string): Promise<void>;
  // Hide a received message for `seconds` instead of letting its visibility timeout bring
  // it straight back. A command the socket cannot carry right now is not a failed delivery,
  // and every redelivery counts toward the dead-letter queue (dispatcher.ts says why).
  defer(receipt: string, seconds: number): Promise<void>;
}

export function sqsCommandSource(client: SQSClient, queueUrl: string): CommandSource {
  return {
    async receive() {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20,
        }),
      );
      return (response.Messages ?? []).flatMap((m) =>
        m.Body && m.ReceiptHandle ? [{ body: m.Body, receipt: m.ReceiptHandle }] : [],
      );
    },
    async settle(receipt) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
    },
    async defer(receipt, seconds) {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receipt,
          VisibilityTimeout: seconds,
        }),
      );
    },
  };
}

// Local dry runs: a queue that feeds its own consumer in-process. It models the visibility
// TIMEOUT as well as the delivery, because the dispatcher leans on it — a command deferred
// while the socket is closed is deliberately left unsettled so the queue brings it back,
// and a stand-in that simply dropped it would silently lose exactly the podium the real
// queue exists to keep.
export function memoryOutbound(): OutboundQueue & CommandSource {
  const pending: QueuedBody[] = [];
  // Received and not settled, each with the instant it becomes visible again.
  const inFlight = new Map<string, { item: QueuedBody; visibleAt: number }>();
  let n = 0;
  const idle = () => new Promise((r) => setTimeout(r, 500));
  return {
    async enqueue(command) {
      pending.push({ body: JSON.stringify(command), receipt: String((n += 1)) });
    },
    async receive() {
      // Anything received and not settled comes back first, in order — once visible.
      if (inFlight.size > 0) {
        await idle();
        const now = Date.now();
        return [...inFlight.values()].filter((f) => f.visibleAt <= now).map((f) => f.item);
      }
      const batch = pending.splice(0, 5);
      if (batch.length === 0) await idle();
      for (const item of batch) inFlight.set(item.receipt, { item, visibleAt: 0 });
      return batch;
    },
    async settle(receipt) {
      inFlight.delete(receipt);
    },
    async defer(receipt, seconds) {
      const held = inFlight.get(receipt);
      if (held) held.visibleAt = Date.now() + seconds * 1_000;
    },
  };
}
