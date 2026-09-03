// Operator commands beside pairing (#236):
//
//   pnpm bot:cli groups                   list the groups the paired account is in, with
//                                         their JIDs — what a group config's `id` needs
//   pnpm bot:cli forget <group> <player>  remove one JID's conversational memory in one
//                                         group; their scoreboard rows are untouched
//
// `groups` opens the socket, so it takes the session lease like the task does.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { dynamoMemoryStore } from './chat/memory';
import { loadEnv } from './config/env';
import { GROUP_JID, USER_JID } from './config/groupConfig';
import { createLog } from './log';
import { useDynamoAuthState } from './whatsapp/authStore';
import { connectWhatsApp } from './whatsapp/client';
import { acquireLease } from './whatsapp/lease';

async function listGroups(): Promise<void> {
  const log = createLog('warn');
  const env = loadEnv();
  const dynamo = new DynamoDBClient({});
  const lease = await acquireLease(dynamo, env.table, 'cli');
  if (!lease) {
    console.error('Another process holds the WhatsApp session (the Fargate task?). Stop it first.');
    process.exit(1);
  }
  // Past here the lease is HANDED BACK whatever happens — an unpaired store, a socket that
  // never opens, a fetch that throws. Holding it on the way out makes the next process (the
  // Fargate task, coming back up) refuse to connect until the full TTL has expired, for a
  // command that has already finished. `process.exitCode` rather than `process.exit()`
  // inside the block, because an exit skips the finally that does the handing back.
  try {
    const auth = await useDynamoAuthState(dynamo, env.table);
    if (!auth.state.creds.registered) {
      console.error('No paired device. Run `pnpm bot:pair` first.');
      process.exitCode = 1;
      return;
    }
    const client = await connectWhatsApp({
      auth,
      log,
      onMessage: async () => {},
      onStop: async (reason) => {
        console.error(`Connection stopped: ${reason}`);
        await lease.release();
        process.exit(1);
      },
    });
    try {
      const deadline = Date.now() + 60_000;
      while (!client.isOpen() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
      const groups = await client.groups();
      for (const g of groups.sort((a, b) => a.subject.localeCompare(b.subject))) {
        console.log(`${g.id}\t${g.size}\t${g.subject}`);
      }
    } finally {
      await client.close();
    }
  } finally {
    await lease.release().catch(() => {});
  }
}

async function forget(group: string | undefined, player: string | undefined): Promise<void> {
  if (!group || !GROUP_JID.test(group) || !player || !USER_JID.test(player)) {
    console.error('usage: bot:cli forget <group JID> <player JID>');
    process.exit(2);
  }
  const env = loadEnv();
  await dynamoMemoryStore(new DynamoDBClient({}), env.table).forget(group, player);
  console.log('Forgotten.');
}

const [command, ...rest] = process.argv.slice(2);
const run =
  command === 'groups'
    ? listGroups()
    : command === 'forget'
      ? forget(rest[0], rest[1])
      : Promise.reject(new Error('usage: bot:cli <groups | forget <group> <player>>'));
// Exit explicitly once the work is done and every `finally` above has run: the AWS SDK's
// keep-alive sockets would otherwise hold the loop open on a command that has finished.
run.then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
