#!/usr/bin/env node
// CDK app entrypoint. Provisions two independent sibling stacks: the daily-puzzle
// backend (#3 — S3 bucket + Lambda(Fn URL) + CloudFront) and the web front hosting
// (#21 — private S3 + CloudFront + ACM + Route53). Run via `cdk synth` / `cdk deploy`
// (cdk.json points the app command at `npx tsx bin/app.ts`); target one with
// `cdk deploy RafaelBackendStack` / `cdk deploy RafaelWebStack`.
import { App } from 'aws-cdk-lib';
import { BackendStack } from '../lib/backend-stack';
import { WebStack } from '../lib/web-stack';

const app = new App();

new BackendStack(app, 'RafaelBackendStack', {
  // The exact web origin allowed to read the API (CORS `Access-Control-Allow-Origin`).
  // Pass at deploy time: `cdk deploy -c allowedOrigin=https://play.chqrles.me`.
  // Defaults to "*" (handy before the real domain exists).
  allowedOrigin: app.node.tryGetContext('allowedOrigin'),
  // Deploy into the account/region from the ambient AWS profile (CDK_DEFAULT_*).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

new WebStack(app, 'RafaelWebStack', {
  // The registered apex domain whose Route53 hosted zone lives in this account, e.g.
  // `cdk deploy RafaelWebStack -c domainName=chqrles.me`. Omit for a credential-free
  // smoke synth on the default *.cloudfront.net domain (no ACM/Route53).
  domainName: app.node.tryGetContext('domainName'),
  // Subdomain under domainName; defaults to "play" (-> play.<domain>). Empty = apex.
  siteSubdomain: app.node.tryGetContext('siteSubdomain'),
  // Pinned to us-east-1: CloudFront's ACM cert must live there, so keeping the whole
  // stack in-region avoids a cross-region certificate reference.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
