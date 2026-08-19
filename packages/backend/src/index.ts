// AWS Lambda entrypoint (Function URL handler). The CDK stack (#3) wires this as
// `index.handler` with puzzle, score-store, secret-parameter, and origin env vars set.
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { createHandler } from './handler';
import { s3Store } from './s3Store';
import { loadConfig, loadScoreSecrets } from './config';
import { dynamoFriendStore } from './dynamoFriendStore';
import { dynamoProfileStore } from './dynamoProfileStore';
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
    .then((secrets) =>
      createHandler({
        store: s3Store(s3, config.bucket),
        allowedOrigin: config.allowedOrigin,
        siteOrigin: config.siteOrigin,
        scores: {
          scoreStore: dynamoScoreStore(dynamo, config.scoreTable),
          turnstile: turnstileVerifier(secrets.turnstileSecret),
          ipHmacSecret: secrets.ipHmacSecret,
        },
        profiles: dynamoProfileStore(dynamo, config.scoreTable),
        friends: dynamoFriendStore(dynamo, config.scoreTable),
      }),
    )
    .catch((error: unknown) => {
      initializedHandler = undefined;
      throw error;
    });
  return initializedHandler;
}

export async function handler(event: FnUrlEvent): Promise<FnUrlResult> {
  return (await initializeHandler())(event);
}
