// Operator commands beside pairing (#236):
//
//   pnpm bot:cli groups                   list the groups the paired account is in, with
//                                         their JIDs — what a group config's `id` needs
//   pnpm bot:cli forget <group> <player>  rewrite the group's diary without one person
//                                         (#277); their scoreboard rows are untouched, and
//                                         their turns in the day log expire on their own
//
// `groups` opens the socket, so it takes the session lease like the task does. `forget`
// needs the model: the diary is one text the bot wrote, and taking a person out of it is
// a rewrite (`chat/diary.ts` `withoutPerson`), checked before it is stored.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { activeDate, dayNumber } from '@whippin/shared';
import { dynamoDiaryStore, stampOf, withoutPerson } from './chat/diary';
import { labelPlayers } from './chat/tools';
import { jidUser } from './chat/trigger';
import { botRegion, loadEnv } from './config/env';
import { GROUP_JID, USER_JID, loadGroups } from './config/groupConfig';
import { dynamoDeclarationStore } from './domain/dynamoDeclarationStore';
import { fallbackName } from './domain/names';
import { createLlmProvider } from './llm';
import { createLog } from './log';
import { hasPairedDevice, useDynamoAuthState } from './whatsapp/authStore';
import { connectWhatsApp } from './whatsapp/client';
import { acquireLease, keepLease } from './whatsapp/lease';

async function listGroups(): Promise<void> {
  const log = createLog('warn');
  const env = loadEnv();
  const dynamo = new DynamoDBClient({ region: botRegion() });
  const lease = await acquireLease(dynamo, env.table, 'cli');
  if (!lease) {
    console.error('Another process holds the WhatsApp session (the Fargate task?). Stop it first.');
    process.exit(1);
  }
  // RENEWED like every other holder's (`lease.ts`): this command waits up to a minute for
  // the socket and then fetches every group, which can outlast the lease's own TTL — and an
  // unrenewed lease is one the Fargate task may take while this socket is still open, which
  // is the two-session state the lease exists to refuse.
  const renew = keepLease(lease, {
    onLost(reason) {
      console.error(
        reason === 'refused'
          ? 'Lost the session lease — is the Fargate task running again? Stopping.'
          : 'The session lease has not renewed for long enough that it may have expired. Stopping.',
      );
      process.exit(1);
    },
    onError: (error) => console.error(`Could not renew the session lease: ${error.message}`),
  });
  // Past here the lease is HANDED BACK whatever happens — an unpaired store, a socket that
  // never opens, a fetch that throws. Holding it on the way out makes the next process (the
  // Fargate task, coming back up) refuse to connect until the full TTL has expired, for a
  // command that has already finished. `process.exitCode` rather than `process.exit()`
  // inside the block, because an exit skips the finally that does the handing back.
  try {
    const auth = await useDynamoAuthState(dynamo, env.table);
    if (!hasPairedDevice(auth.state.creds)) {
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
        renew.stop();
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
    renew.stop();
    await lease.release().catch(() => {});
  }
}

async function forget(groupJid: string | undefined, who: string | undefined): Promise<void> {
  if (!groupJid || !GROUP_JID.test(groupJid) || !who) {
    console.error('usage: bot:cli forget <group JID> <player JID | the name the diary uses>');
    process.exit(2);
  }
  const log = createLog('warn');
  const env = loadEnv();
  const group = loadGroups(env.groupsDir).get(groupJid);
  if (!group) {
    console.error('No enabled config for that group in the snapshot (`pnpm bot:groups pull`).');
    process.exit(1);
  }
  const provider = await createLlmProvider(env.llm, () => new SSMClient({ region: botRegion() }));
  if (!provider) {
    console.error('No model configured (BOT_LLM_API_KEY or BOT_LLM_API_KEY_PARAMETER): the diary is rewritten by the model.');
    process.exit(1);
  }
  const dynamo = new DynamoDBClient({ region: botRegion() });
  // A JID OR A NAME (PR-278 review). The diary writes people by the name the GROUP uses,
  // and a JID only reaches one through the scoreboard rows — so a member who has never
  // posted a score, or who renamed since, resolved to the `…last4` handle and the command
  // reported cheerfully that the diary never mentioned them. A JID is still resolved; when
  // nothing but the handle comes back, the operator is asked for the name, which they can
  // read in the diary itself.
  let name = who;
  if (USER_JID.test(who)) {
    const today = dayNumber(activeDate(new Date()));
    const names = await labelPlayers({ group, today, declarations: dynamoDeclarationStore(dynamo, env.table) }, [who]);
    const resolved = names.get(who) ?? '';
    if (resolved === '' || resolved === fallbackName(jidUser(who))) {
      console.error('The group has no name on record for that JID — they have never posted a score here, or they renamed since.');
      console.error(`Run it again with the name the diary uses: bot:cli forget ${groupJid} "<name>"`);
      process.exitCode = 1;
      return;
    }
    name = resolved;
  }
  const diaries = dynamoDiaryStore(dynamo, env.table);
  const diary = await diaries.get(group.id);
  if (!diary) {
    console.log('No diary for this group yet; nothing to forget.');
    return;
  }
  const next = await withoutPerson(provider, group, diary, name, log);
  if (!next) {
    console.error('The rewrite could not be verified free of them; the diary is unchanged. Try again.');
    process.exitCode = 1;
    return;
  }
  if (next === diary) {
    console.log(`The diary does not mention ${name}; nothing changed.`);
    return;
  }
  // Conditional, like the nightly rewrite: if the diary moved while the model was writing
  // (the day flip, another operator), nothing is stored over it.
  if (!(await diaries.put(group.id, next, stampOf(diary)))) {
    console.error('The diary changed while it was being rewritten (the nightly job?); nothing stored. Run it again.');
    process.exitCode = 1;
    return;
  }
  console.log('Forgotten. Their turns in the day log expire within 48 hours.');
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
