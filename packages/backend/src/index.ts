// AWS Lambda entrypoint (Function URL handler). The CDK stack (#3) wires this as
// `index.handler` with puzzle, score-store, secret, and origin env vars set.
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createHandler } from './handler';
import { s3Store } from './s3Store';
import { loadConfig } from './config';
import { dynamoScoreStore } from './dynamoScoreStore';
import { turnstileVerifier } from './turnstile';

const config = loadConfig();
const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});

export const handler = createHandler({
  store: s3Store(s3, config.bucket),
  allowedOrigin: config.allowedOrigin,
  siteOrigin: config.siteOrigin,
  scores: {
    scoreStore: dynamoScoreStore(dynamo, config.scoreTable),
    turnstile: turnstileVerifier(config.turnstileSecret),
    ipHmacSecret: config.ipHmacSecret,
  },
});
