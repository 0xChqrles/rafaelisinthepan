// AWS Lambda entrypoint (Function URL handler). The CDK stack (#3) wires this as
// `index.handler` with PUZZLE_BUCKET / ALLOWED_ORIGIN env vars set.
import { S3Client } from '@aws-sdk/client-s3';
import { createHandler } from './handler';
import { s3Store } from './s3Store';
import { loadConfig } from './config';

const config = loadConfig();
const client = new S3Client({});

export const handler = createHandler({
  store: s3Store(client, config.bucket),
  allowedOrigin: config.allowedOrigin,
});
