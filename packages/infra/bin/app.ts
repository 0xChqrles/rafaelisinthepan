#!/usr/bin/env node
// CDK app entrypoint. Provisions two independent sibling stacks: the daily-puzzle
// backend (#3/#169 — S3 + DynamoDB + Lambda(Fn URL) + CloudFront) and the web front hosting
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
import { App, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { BackendStack } from '../lib/backend-stack';
import { WebStack } from '../lib/web-stack';
import { DeployRoleStack } from '../lib/deploy-role-stack';

const app = new App();

// Automated best-practice/security linting on synth (AWS Solutions ruleset). Findings fail
// synth unless suppressed with a written justification (see NagSuppressions in each stack).
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
// Cost-allocation / ownership tags applied to every taggable resource in both stacks.
Tags.of(app).add('Project', 'whippin');
Tags.of(app).add('ManagedBy', 'cdk');

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
  // Canonical site origin for the share card's absolute URLs (#8); the apex site host.
  siteOrigin: `https://${siteHost}`,
  // Existing SSM SecureString names; override for another environment/account.
  turnstileSecretParameter:
    app.node.tryGetContext('turnstileSecretParameter') ?? '/whippin/turnstile-secret',
  ipHmacSecretParameter:
    app.node.tryGetContext('ipHmacSecretParameter') ?? '/whippin/ip-hmac-secret',
  // Where a human is reached (#230): the confirmed SNS subscription behind the SES
  // reputation alarms, and the inbox that inbound mail for the domain is forwarded to.
  // DELIBERATELY WITHOUT A DEFAULT — it is a personal address, and this repo is public.
  // CI supplies it as a repository variable; unset, the mail plumbing is simply not built
  // (see lib/mail.ts for why a half-built version would be worse than none).
  operatorEmail: app.node.tryGetContext('operatorEmail') || undefined,
  env,
});

new WebStack(app, 'WhippinWebStack', {
  // Site host = `<siteSubdomain>.<domainName>`, siteSubdomain defaulting to "" (apex).
  domainName,
  siteSubdomain,
  // The backend origin the SPA calls — drives the CSP `connect-src`. Mirrors the
  // BackendStack API domain (`api.<domain>`); undefined in the no-domain smoke synth.
  apiOrigin: domainName ? `https://${apiSubdomain}.${domainName}` : undefined,
  env,
});

// CI auth bootstrap (issue #33): the GitHub OIDC provider + the IAM role the Deploy
// workflow assumes (its ARN → the repo secret AWS_DEPLOY_ROLE_ARN). Independent of the
// two app stacks and domain-agnostic; deployed ONCE by a human — the CI role itself
// cannot deploy this stack (it can't edit IAM). `-c` knobs default to this repo. Context
// values arrive as strings, so `enablePreviewRole` compares against the literal "true".
new DeployRoleStack(app, 'WhippinDeployStack', {
  githubOwner: app.node.tryGetContext('githubOwner') ?? '0xChqrles',
  githubRepo: app.node.tryGetContext('githubRepo') ?? 'rafaelisinthepan',
  deployBranch: app.node.tryGetContext('deployBranch') ?? 'main',
  enablePreviewRole: `${app.node.tryGetContext('enablePreviewRole') ?? ''}` === 'true',
  // The account GitHub OIDC provider is imported by default (it's one-per-account and
  // usually already exists). On a fresh account with none, `-c createOidcProvider=true`
  // creates it; `-c githubOidcProviderArn=<arn>` imports a specific one.
  createOidcProvider: `${app.node.tryGetContext('createOidcProvider') ?? ''}` === 'true',
  githubOidcProviderArn: app.node.tryGetContext('githubOidcProviderArn') ?? undefined,
  env,
});
