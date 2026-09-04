// Pairing is an OPERATOR PATH, not an HTTP endpoint (#236): run on a laptop with AWS
// credentials, it prints the QR (or, with --phone, a pairing code), and writes the
// resulting auth state to the same durable store the Fargate task consumes. Fargate
// exposes no pairing UI and needs no inbound listener.
//
//   pnpm bot:pair                 QR in the terminal
//   pnpm bot:pair --phone 33612345678   pairing code for that number (digits only)
//   pnpm bot:pair --reset         wipe the stored auth first (an explicit re-pair)
//
// The Fargate task must be STOPPED first (scale the service to 0): the session lease
// refuses to pair while a task holds it, and that refusal is the point.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import qrcode from 'qrcode-terminal';
import { BOT_REGION, loadEnv } from './config/env';
import { createLog } from './log';
import { clearAuthInvalidated, useDynamoAuthState } from './whatsapp/authStore';
import { connectWhatsApp } from './whatsapp/client';
import { acquireLease, keepLease } from './whatsapp/lease';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const log = createLog();
  const env = loadEnv({ ...process.env, BOT_TABLE: process.env.BOT_TABLE });
  const dynamo = new DynamoDBClient({ region: BOT_REGION });
  const phone = flag('--phone');
  const reset = process.argv.includes('--reset');
  // Checked BEFORE the lease and the socket: a malformed number only ever surfaces as a
  // `pairing.failed` log from inside the connection, while the CLI sits on its five-minute
  // deadline waiting for a pairing that was never requested.
  if (phone !== undefined && !/^\d{6,15}$/.test(phone)) {
    console.error('usage: pnpm bot:pair [--phone <digits only, country code first, no +>] [--reset]');
    process.exit(2);
  }

  const lease = await acquireLease(dynamo, env.table, 'pair');
  if (!lease) {
    console.error('Another process holds the WhatsApp session (the Fargate task?). Stop it first.');
    process.exit(1);
  }
  // The lease's own rule (`lease.ts`): a holder that cannot renew STOPS rather than keep
  // talking. A pairing that carried on after losing the lease would be writing Signal state
  // beside a second socket, which is the one thing the lease exists to prevent.
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

  // Past here the lease is handed back on EVERY path, a throw from Baileys included:
  // leaving it held makes the Fargate task refuse to start until the whole TTL expires.
  // `process.exitCode` rather than `process.exit()` inside, because an exit would skip the
  // finally that does the handing back.
  try {
    let auth = await useDynamoAuthState(dynamo, env.table);
    if (auth.state.creds.registered && !reset) {
      console.log('A paired device is already stored. Re-run with --reset to pair again.');
      return;
    }
    if (reset) {
      console.log('Wiping the stored auth state…');
      await auth.wipe();
      auth = await useDynamoAuthState(dynamo, env.table);
    }

    const client = await connectWhatsApp({
      auth,
      log,
      onMessage: async () => {},
      async onStop(reason) {
        console.error(`Connection stopped: ${reason}`);
        renew.stop();
        await lease.release();
        process.exit(1);
      },
      onQr: phone
        ? undefined
        : (qr) => {
            console.log('\nScan this with WhatsApp > Linked devices > Link a device:\n');
            qrcode.generate(qr, { small: true });
          },
      pairingPhone: phone,
      onPairingCode: (code) => console.log(`\nPairing code for ${phone}: ${code}\n`),
    });

    let closed = false;
    try {
      // Wait for the socket to open (post-pairing Baileys restarts once, then opens).
      const deadline = Date.now() + 5 * 60_000;
      while (!client.isOpen()) {
        if (Date.now() > deadline) {
          console.error('Timed out waiting for the pairing to complete.');
          process.exitCode = 1;
          return;
        }
        await wait(500);
      }
      // Give the socket a moment to flush the post-login key/creds updates to the store.
      await wait(5_000);
      // CLOSE BEFORE DECLARING SUCCESS. Closing drains the credential queue, and the drain
      // rejects when the last snapshot — the one that registered the device — did not
      // land. Success printed before that point was a claim about a store that might hold
      // a session nobody can resume, and the invalidation flag is cleared only once the
      // store demonstrably holds the new one.
      const self = client.selfJids();
      closed = true;
      await client.close();
      await clearAuthInvalidated(dynamo, env.table);
      console.log(`Paired as ${self.join(' / ')}. Auth state is in ${env.table}.`);
      console.log('You can start the Fargate task now (scale the service back to 1).');
    } finally {
      if (!closed) await client.close().catch((error) => console.error((error as Error).message));
    }
  } finally {
    renew.stop();
    await lease.release().catch(() => {});
  }
}

// Exit explicitly once every `finally` above has run: the AWS SDK's keep-alive sockets
// would otherwise hold the loop open on a command that has finished.
main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
