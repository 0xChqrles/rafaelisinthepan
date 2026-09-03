// The outbound queue's transport. A producer sends one command per SQS message; the
// consumer long-polls, hands each body to the dispatcher, and deletes the message only on a
// settled outcome (sent, already sent, or unsendable by construction). A transient failure
// leaves the message to reappear after its visibility timeout — SQS's own retry.

import {
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
  };
}

// Local dry runs: a queue that feeds its own consumer in-process. It models the visibility
// TIMEOUT as well as the delivery, because the dispatcher leans on it — a command deferred
// while the socket is closed is deliberately left unsettled so the queue brings it back,
// and a stand-in that simply dropped it would silently lose exactly the podium the real
// queue exists to keep.
export function memoryOutbound(): OutboundQueue & CommandSource {
  const pending: QueuedBody[] = [];
  const inFlight = new Map<string, QueuedBody>();
  let n = 0;
  const idle = () => new Promise((r) => setTimeout(r, 500));
  return {
    async enqueue(command) {
      pending.push({ body: JSON.stringify(command), receipt: String((n += 1)) });
    },
    async receive() {
      // Anything received and not settled comes back first, in order.
      if (inFlight.size > 0) {
        await idle();
        return [...inFlight.values()];
      }
      const batch = pending.splice(0, 5);
      if (batch.length === 0) await idle();
      for (const item of batch) inFlight.set(item.receipt, item);
      return batch;
    },
    async settle(receipt) {
      inFlight.delete(receipt);
    },
  };
}
