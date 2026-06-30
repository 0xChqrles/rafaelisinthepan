#!/usr/bin/env node
// CDK app entrypoint. Provisions two independent sibling stacks: the daily-puzzle
// backend (#3 — S3 bucket + Lambda(Fn URL) + CloudFront) and the web front hosting
// (#21 — private S3 + CloudFront + ACM + Route53). Run via `cdk synth` / `cdk deploy`
// (cdk.json points the app command at `npx tsx bin/app.ts`); target one with
// `cdk deploy WhippinBackendStack` / `cdk deploy WhippinWebStack`.
//
// Both stacks are pinned to us-east-1 — CloudFront's ACM certs must live there, so the
// certs stay in-stack with no cross-region reference. The apex comes from `-c domainName=<apex>`
// (defaults to whippin.ai): the site serves at the apex (e.g. https://whippin.ai), the API at
// api.<domain> (a stable VITE_API_BASE_URL), and the backend CORS origin defaults to the site
// origin. (The puzzle bucket name is CloudFormation-generated — discovered via the
// PuzzleBucketName output, not derived from the domain.)
import { App } from 'aws-cdk-lib';
import { BackendStack } from '../lib/backend-stack';
import { WebStack } from '../lib/web-stack';

const app = new App();

// Shared deploy-time inputs. `domainName` is the registered apex whose Route53 hosted zone
// already lives in this account. It DEFAULTS to the project apex, so every cdk command
// (bootstrap/synth/deploy) works with no flag; override with `-c domainName=<other-apex>`
// for a different deployment.
const domainName: string = app.node.tryGetContext('domainName') ?? 'whippin.ai';
const siteSubdomain: string = app.node.tryGetContext('siteSubdomain') ?? ''; // "" = apex
const apiSubdomain: string = app.node.tryGetContext('apiSubdomain') ?? 'api';
// The site's final origin — used as the backend's default CORS allowedOrigin.
const siteHost = siteSubdomain ? `${siteSubdomain}.${domainName}` : domainName;

// us-east-1 for both: CloudFront ACM certs must live there (see file header).
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

new BackendStack(app, 'WhippinBackendStack', {
  // The exact web origin allowed to read the API (CORS `Access-Control-Allow-Origin`).
  // Defaults to the site origin derived from `domainName`; override with
  // `-c allowedOrigin=https://...`.
  allowedOrigin: app.node.tryGetContext('allowedOrigin') ?? `https://${siteHost}`,
  // The API's stable custom domain `<apiSubdomain>.<domainName>`.
  domainName,
  apiSubdomain,
  env,
});

new WebStack(app, 'WhippinWebStack', {
  // Site host = `<siteSubdomain>.<domainName>`, siteSubdomain defaulting to "" (apex).
  domainName,
  siteSubdomain,
  env,
});
