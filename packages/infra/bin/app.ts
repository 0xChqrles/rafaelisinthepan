#!/usr/bin/env node
// CDK app entrypoint (#3). Provisions the daily-puzzle backend (#2): S3 bucket +
// Lambda (Function URL) + CloudFront. Run via `cdk synth` / `cdk deploy` (cdk.json
// points the app command at `npx tsx bin/app.ts`).
import { App } from 'aws-cdk-lib';
import { BackendStack } from '../lib/backend-stack';

const app = new App();

new BackendStack(app, 'RafaelBackendStack', {
  // The exact web origin allowed to read the API (CORS `Access-Control-Allow-Origin`).
  // Pass at deploy time: `cdk deploy -c allowedOrigin=https://rafael.example`.
  // Defaults to "*" (handy before the real domain exists).
  allowedOrigin: app.node.tryGetContext('allowedOrigin'),
  // Deploy into the account/region from the ambient AWS profile (CDK_DEFAULT_*).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
