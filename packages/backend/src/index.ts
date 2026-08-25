// AWS Lambda entrypoint (Function URL handler). The CDK stack (#3) wires this as
// `index.handler` with puzzle, score-store, secret-parameter, and origin env vars set.
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { createHandler } from './handler';
import { s3Store } from './s3Store';
import { loadConfig, loadScoreSecrets } from './config';
import { dynamoDeviceStore } from './dynamoDeviceStore';
import { dynamoFriendStore } from './dynamoFriendStore';
import { dynamoHistoryStore } from './dynamoHistoryStore';
import { dynamoProfileStore } from './dynamoProfileStore';
import { dynamoRoundStore } from './dynamoRoundStore';
import { dynamoScoreStore } from './dynamoScoreStore';
import { turnstileVerifier } from './turnstile';
import type { FnUrlEvent, FnUrlResult } from './respond';

const config = loadConfig();
const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

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
      return createHandler({
        store: s3Store(s3, config.bucket),
        allowedOrigin: config.allowedOrigin,
        siteOrigin: config.siteOrigin,
        // Read-only since #203: the population is WRITTEN by the round route below.
        scores: { scoreStore },
        profiles: dynamoProfileStore(dynamo, config.scoreTable),
        friends: dynamoFriendStore(dynamo, config.scoreTable),
        // Devices and their accounts (#216): the ONE store every authenticated route
        // resolves its caller through, and the Turnstile-gated bootstrap that mints one.
        deviceStore,
        devices: { turnstile },
        rounds: {
          roundStore: dynamoRoundStore(dynamo, config.scoreTable),
          // A finished round records its own score row (#203), so the round route holds
          // the same store the /scores read does — and the address secret that meters it.
          scoreStore,
          ipHmacSecret: secrets.ipHmacSecret,
          // ROUND START is Turnstile-gated in both modes (#202/#203); since #216 the device
          // bootstrap is the other gated write.
          turnstile,
          // A confirmed solve credits the streak's day (#211); `/history` reads it back.
          history: dynamoHistoryStore(dynamo, config.scoreTable),
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
