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
import { loadEnv } from './config/env';
import { createLog } from './log';
import { clearAuthInvalidated, useDynamoAuthState } from './whatsapp/authStore';
import { connectWhatsApp } from './whatsapp/client';
import { LEASE_RENEW_MS, acquireLease } from './whatsapp/lease';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
}

async function main(): Promise<void> {
  const log = createLog();
  const env = loadEnv({ ...process.env, BOT_TABLE: process.env.BOT_TABLE });
  const dynamo = new DynamoDBClient({});
  const phone = flag('--phone');
  const reset = process.argv.includes('--reset');

  const lease = await acquireLease(dynamo, env.table, 'pair');
  if (!lease) {
    console.error('Another process holds the WhatsApp session (the Fargate task?). Stop it first.');
    process.exit(1);
  }
  // The lease's own rule (`lease.ts`): a holder that cannot renew STOPS rather than keep
  // talking. Ignoring the answer would let a pairing that has LOST the lease — to a task
  // somebody scaled back up mid-pair — carry on writing Signal state beside a second
  // socket, which is the one thing the lease exists to prevent. A renew that merely FAILED
  // (a network blip) is not a lost lease and only warns, as it does in the task.
  const renew = setInterval(() => {
    lease.renew().then(
      (held) => {
        if (held) return;
        console.error('Lost the session lease — is the Fargate task running again? Stopping.');
        process.exit(1);
      },
      (error) => console.error(`Could not renew the session lease: ${(error as Error).message}`),
    );
  }, LEASE_RENEW_MS);

  let auth = await useDynamoAuthState(dynamo, env.table);
  if (auth.state.creds.registered && !reset) {
    console.log('A paired device is already stored. Re-run with --reset to pair again.');
    clearInterval(renew);
    await lease.release();
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
      clearInterval(renew);
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

  // Wait for the socket to open (post-pairing Baileys restarts once, then opens).
  const deadline = Date.now() + 5 * 60_000;
  while (!client.isOpen()) {
    if (Date.now() > deadline) {
      console.error('Timed out waiting for the pairing to complete.');
      await client.close();
      clearInterval(renew);
      await lease.release();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Give the socket a moment to flush the post-login key/creds updates to the store.
  await new Promise((r) => setTimeout(r, 5_000));
  await clearAuthInvalidated(dynamo, env.table);
  console.log(`Paired as ${client.selfJids().join(' / ')}. Auth state is in ${env.table}.`);
  console.log('You can start the Fargate task now (scale the service back to 1).');
  await client.close();
  clearInterval(renew);
  await lease.release();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
