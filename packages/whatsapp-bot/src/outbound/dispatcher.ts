// The dispatcher: command in, WhatsApp send out, record after. It owns the ONLY calls to
// the transport's send API in the running task, so every message the bot ever posts has
// a command id and a recorded WhatsApp id behind it.

import type { GroupRegistry } from '../config/groupConfig';
import type { Log } from '../log';
import { tag } from '../log';
import { parseCommand, type OutboundCommand } from './commands';
import type { SentStore } from './dedupStore';
import type { CommandSource } from './sqs';

export interface Sender {
  // Resolves to the WhatsApp id of the sent message.
  send(command: OutboundCommand): Promise<string>;
  isOpen(): boolean;
}

export type DispatchOutcome = 'sent' | 'duplicate' | 'dropped' | 'deferred';

export interface Dispatcher {
  dispatch(body: string): Promise<DispatchOutcome>;
}

export function createDispatcher(deps: {
  sender: Sender;
  sent: SentStore;
  groups: GroupRegistry;
  log: Log;
  now?: () => Date;
}): Dispatcher {
  const now = deps.now ?? (() => new Date());
  return {
    async dispatch(body) {
      const command = parseCommand(body);
      if (!command) {
        deps.log.warn({ event: 'outbound.malformed' }, 'dropping a malformed outbound command');
        return 'dropped';
      }
      // The allow-list holds on the way OUT too: a command for a group that is not (or no
      // longer) configured is not sent, whoever queued it.
      if (!deps.groups.get(command.group)) {
        deps.log.warn(
          { event: 'outbound.unknown_group', command: command.id, group: tag(command.group) },
          'dropping a command for an unconfigured group',
        );
        return 'dropped';
      }
      const already = await deps.sent.get(command.group, command.id);
      if (already) {
        deps.log.info({ event: 'outbound.duplicate', command: command.id }, 'already sent');
        return 'duplicate';
      }
      if (!deps.sender.isOpen()) return 'deferred';
      const waMessageId = await deps.sender.send(command);
      await deps.sent.put(command.group, {
        commandId: command.id,
        waMessageId,
        sentAt: now().toISOString(),
      });
      deps.log.info(
        { event: 'outbound.sent', command: command.id, kind: command.kind, waMessageId },
        'sent',
      );
      return 'sent';
    },
  };
}

// The consumer loop: runs until `stop()` resolves the signal. A deferred command (socket
// closed) is left unsettled so the queue redelivers it once the connection is back.
export function runConsumer(
  source: CommandSource,
  dispatcher: Dispatcher,
  log: Log,
  signal: AbortSignal,
): Promise<void> {
  return (async () => {
    while (!signal.aborted) {
      let batch;
      try {
        batch = await source.receive();
      } catch (error) {
        log.error({ event: 'outbound.receive_failed', error: (error as Error).message });
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      for (const item of batch) {
        try {
          const outcome = await dispatcher.dispatch(item.body);
          if (outcome !== 'deferred') await source.settle(item.receipt);
        } catch (error) {
          // Transient: leave the message for redelivery.
          log.error({ event: 'outbound.dispatch_failed', error: (error as Error).message });
        }
      }
    }
  })();
}
