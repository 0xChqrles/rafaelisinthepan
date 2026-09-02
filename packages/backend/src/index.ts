// AWS Lambda entrypoint (Function URL handler). The CDK stack (#3) wires this as
// `index.handler` with puzzle, score-store, secret-parameter, and origin env vars set.
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SSMClient } from '@aws-sdk/client-ssm';
import { createHandler } from './handler';
import { s3Store } from './s3Store';
import { loadConfig, loadScoreSecrets } from './config';
import { dynamoDeviceStore } from './dynamoDeviceStore';
import { dynamoFriendStore } from './dynamoFriendStore';
import { dynamoHistoryStore } from './dynamoHistoryStore';
import { dynamoLinkStore } from './dynamoLinkStore';
import { dynamoProfileStore } from './dynamoProfileStore';
import { dynamoRoundStore } from './dynamoRoundStore';
import { dynamoScoreStore } from './dynamoScoreStore';
import { sesMailer } from './mailer';
import { turnstileVerifier } from './turnstile';
import type { FnUrlEvent, FnUrlResult } from './respond';

const config = loadConfig();
const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});
const ses = new SESv2Client({});

type ProductionHandler = ReturnType<typeof createHandler>;

// Initialize on the first invocation and cache only a successful attempt. Concurrent
// invocations share the same request; a transient SSM failure is retried next time.
let initializedHandler: Promise<ProductionHandler> | undefined;

function initializeHandler(): Promise<ProductionHandler> {
  initializedHandler ??= loadScoreSecrets(ssm, config)
    .then((secrets) => {
      const scoreStore = dynamoScoreStore(dynamo, config.scoreTable);
      // ONE Turnstile verifier: the two gated writes (a device bootstrap and a round
      // start) are the same challenge against the same secret.
      const turnstile = turnstileVerifier(secrets.turnstileSecret);
      const deviceStore = dynamoDeviceStore(dynamo, config.scoreTable);
      // ONE of each store: the link route MOVES rows the round, score, friend and history
      // routes own, so it has to act on the very same instances those routes read.
      const roundStore = dynamoRoundStore(dynamo, config.scoreTable);
      const friendStore = dynamoFriendStore(dynamo, config.scoreTable);
      const historyStore = dynamoHistoryStore(dynamo, config.scoreTable);
      return createHandler({
        store: s3Store(s3, config.bucket),
        allowedOrigin: config.allowedOrigin,
        siteOrigin: config.siteOrigin,
        // Read-only since #203: the population is WRITTEN by the round route below.
        scores: { scoreStore },
        profiles: dynamoProfileStore(dynamo, config.scoreTable),
        friends: friendStore,
        // Devices and their accounts (#216): the ONE store every authenticated route
        // resolves its caller through, and the Turnstile-gated bootstrap that mints one.
        deviceStore,
        devices: { turnstile },
        rounds: {
          roundStore,
          // A finished round records its own score row (#203), so the round route holds
          // the same store the /scores read does — and the address secret that meters it.
          scoreStore,
          ipHmacSecret: secrets.ipHmacSecret,
          // ROUND START is Turnstile-gated in both modes (#202/#203); since #216 the device
          // bootstrap is the other gated write.
          turnstile,
          // A confirmed solve credits the streak's day (#211); `/history` reads it back.
          history: historyStore,
        },
        // Email account linking (#204). It reaches across the other routes' stores — a
        // verified link moves the day's round and score rows, credits the adopting
        // account's solved days and merges the friend graph — and sends its codes through
        // SES, gated by the same Turnstile verifier and metered by the same address secret.
        link: {
          links: dynamoLinkStore(dynamo, config.scoreTable),
          friends: friendStore,
          history: historyStore,
          mailer: sesMailer(ses, config.mailFrom),
          turnstile,
          ipHmacSecret: secrets.ipHmacSecret,
        },
      });
    })
    .catch((error: unknown) => {
      initializedHandler = undefined;
      throw error;
    });
  return initializedHandler;
}

export async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
  return (await initializeHandler())(event);
}
