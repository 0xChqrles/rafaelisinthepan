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

// Local dry runs: a queue that feeds its own consumer in-process.
export function memoryOutbound(): OutboundQueue & CommandSource {
  const pending: QueuedBody[] = [];
  let n = 0;
  return {
    async enqueue(command) {
      pending.push({ body: JSON.stringify(command), receipt: String((n += 1)) });
    },
    async receive() {
      const batch = pending.splice(0, 5);
      if (batch.length === 0) await new Promise((r) => setTimeout(r, 500));
      return batch;
    },
    async settle() {},
  };
}
