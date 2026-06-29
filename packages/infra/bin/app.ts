#!/usr/bin/env node
// CDK app entrypoint. Provisions two independent sibling stacks: the daily-puzzle
// backend (#3 — S3 bucket + Lambda(Fn URL) + CloudFront) and the web front hosting
// (#21 — private S3 + CloudFront + ACM + Route53). Run via `cdk synth` / `cdk deploy`
// (cdk.json points the app command at `npx tsx bin/app.ts`); target one with
// `cdk deploy RafaelBackendStack` / `cdk deploy RafaelWebStack`.
//
// Both stacks are pinned to us-east-1 — CloudFront's ACM certs must live there, so the
// certs stay in-stack with no cross-region reference. With a single `-c domainName=<apex>`
// the site serves at the apex (e.g. https://whippin.ai) and the API at api.<domain>
// (a stable VITE_API_BASE_URL); the backend CORS origin defaults to the site origin.
import { App } from 'aws-cdk-lib';
import { BackendStack } from '../lib/backend-stack';
import { WebStack } from '../lib/web-stack';

const app = new App();

// Shared deploy-time inputs. `domainName` is the registered apex whose Route53 hosted zone
// already lives in this account (e.g. `-c domainName=whippin.ai`); omit it for a
// credential-free smoke synth on the default *.cloudfront.net domains (no ACM/Route53).
const domainName: string | undefined = app.node.tryGetContext('domainName');
const siteSubdomain: string = app.node.tryGetContext('siteSubdomain') ?? ''; // "" = apex
const apiSubdomain: string = app.node.tryGetContext('apiSubdomain') ?? 'api';
// The site's final origin — used as the backend's default CORS allowedOrigin.
const siteHost = domainName
  ? siteSubdomain
    ? `${siteSubdomain}.${domainName}`
    : domainName
  : undefined;

// us-east-1 for both: CloudFront ACM certs must live there (see file header).
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

new BackendStack(app, 'RafaelBackendStack', {
  // The exact web origin allowed to read the API (CORS `Access-Control-Allow-Origin`).
  // Defaults to the site origin derived from `domainName`; override with
  // `-c allowedOrigin=https://...`. Falls back to "*" in the stack before any domain.
  allowedOrigin: app.node.tryGetContext('allowedOrigin') ?? (siteHost ? `https://${siteHost}` : undefined),
  // When set, the API gets a stable custom domain `<apiSubdomain>.<domainName>`.
  domainName,
  apiSubdomain,
  env,
});

new WebStack(app, 'RafaelWebStack', {
  // Site host = `<siteSubdomain>.<domainName>`, siteSubdomain defaulting to "" (apex).
  domainName,
  siteSubdomain,
  env,
});
