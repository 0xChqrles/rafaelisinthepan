import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Stack,
  type StackProps,
  Duration,
  CfnOutput,
  RemovalPolicy,
  Aws,
  ArnFormat,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  DEVICE_INDEX_NAME,
  DEVICE_INDEX_PARTITION_KEY,
  DEVICE_INDEX_SORT_KEY,
  VIEWER_IP_HEADER,
} from '@whippin/shared';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { NagSuppressions } from 'cdk-nag';
import { MailAlerts, MailReceiving } from './mail';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/infra/lib
// The Lambda IS the backend package's existing entrypoint (createHandler over the S3 puzzle
// store + DynamoDB score store); nothing is duplicated here. esbuild bundles it (and @whippin/shared)
// at synth time; @aws-sdk/* is left external (provided by the Node runtime).
const LAMBDA_ENTRY = path.resolve(here, '..', '..', 'backend', 'src', 'index.ts');
const REPO_LOCKFILE = path.resolve(here, '..', '..', '..', 'pnpm-lock.yaml');
// The share-card rasterizer assets (resvg .wasm + pixel font, #8) that ogCard.ts reads from
// `./assets` at runtime. esbuild bundles resvg-wasm's JS but not these data files, so copy
// them next to the bundled index.mjs so the same `./assets/*` paths resolve in the Lambda.
const LAMBDA_ASSETS = path.resolve(here, '..', '..', 'backend', 'src', 'assets');

interface BackendStackProps extends StackProps {
  // The exact web origin permitted to read the API via CORS. Defaults to "*".
  allowedOrigin?: string;
  // Registered apex domain with a Route53 hosted zone in this account (e.g. "whippin.ai").
  // When set, the API gets a stable custom domain `<apiSubdomain>.<domainName>` so
  // VITE_API_BASE_URL never depends on the churn-prone *.cloudfront.net name: a
  // DNS-validated ACM cert in-stack (this stack must be in us-east-1 for CloudFront) plus
  // Route53 A/AAAA aliases. When omitted, the API stays on its *.cloudfront.net domain.
  domainName?: string;
  // Subdomain label for the API under `domainName` (default "api" -> api.<domain>).
  apiSubdomain?: string;
  // Canonical site origin (apex, e.g. https://whippin.ai) for the share card's absolute URLs
  // (og:image + game redirect, #8). The apex CloudFront routes /s/* and /og/* here.
  siteOrigin?: string;
  // Existing SSM SecureString parameters. The Lambda environment receives these names and
  // resolves both encrypted values together on first use, caching only a successful read.
  turnstileSecretParameter?: string;
  ipHmacSecretParameter?: string;
  // The LOCAL PART of the SES sender the #204 link codes go out as, under `domainName`
  // (default "hello" -> hello@<domain>). The domain identity is verified in-stack below;
  // with no custom domain there is nothing to verify and no mail to send, so the sender
  // has to be supplied whole via `mailFrom`.
  mailSender?: string;
  mailFrom?: string;
  // Where a human is reached (#230). ONE address, because every use of it is the same job:
  // it is the confirmed SNS subscription behind the SES reputation alarms, AND the inbox
  // mail received at `<domain>` is forwarded to. With it unset the stack builds neither —
  // an alarm nobody is subscribed to and an MX nobody reads are the failure this plumbing
  // exists to remove, not a lesser version of it.
  operatorEmail?: string;
}

export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps = {}) {
    super(scope, id, props);

    const allowedOrigin = props.allowedOrigin ?? '*';
    const turnstileSecretParameter =
      props.turnstileSecretParameter ?? '/whippin/turnstile-secret';
    const ipHmacSecretParameter =
      props.ipHmacSecretParameter ?? '/whippin/ip-hmac-secret';

    // ── SES: the address #204's link codes are sent FROM ─────────────────────
    // Email is this game's account backup (#204), so the sender has to be an address the
    // provider will accept: a DOMAIN identity with EasyDKIM, whose CNAMEs are published into
    // the same hosted zone the API's records live in. `mailFromDomain` is deliberately NOT
    // set — a custom MAIL FROM needs its own MX record and buys nothing while every message
    // is a six-digit code to a person who just asked for one.
    //
    // **The SANDBOX is a manual step**, and the one that decides whether this works: a new
    // account may only send to verified addresses until AWS lifts it, so a fresh deployment
    // sends codes into a void for every address but the operator's own. The request is made
    // by hand in the SES console (`aws sesv2 put-account-details`), which is why it is
    // written down here rather than automated.
    //
    // DKIM/SPF/DMARC: EasyDKIM below publishes the three DKIM CNAMEs; SPF and DMARC are TXT
    // records on the apex and belong to whoever owns the zone's mail policy, so they are a
    // documented operator step too rather than records this stack would silently overwrite.
    const mailSender = props.mailSender ?? 'hello';
    const mailFrom =
      props.mailFrom ?? (props.domainName ? `${mailSender}@${props.domainName}` : undefined);
    if (!mailFrom) {
      throw new Error(
        'BackendStack needs a sender for #204 link codes: pass `mailFrom`, or `domainName` to derive one.',
      );
    }

    // ── S3: the private puzzle bucket ─────────────────────────────────────────
    // Holds the `<YYYY-MM-DD>.<lang>.json` objects keyed by backend/src/layout.ts
    // (`storeKey`) — the upload target for #4. Fully private: blocks all public
    // access, enforces TLS, encrypts at rest. RETAIN so tearing down the stack never drops
    // accumulated puzzle history.
    //
    // The name is intentionally NOT hardcoded — CloudFormation auto-generates a unique one.
    // A fixed physical name is an anti-pattern here: S3 names are globally unique (cross-account
    // collisions, slow release on replacement) and, combined with RETAIN, a teardown ORPHANS the
    // bucket so the next deploy collides on the same name (the original deploy failure). Nothing
    // needs the literal name: the Lambda reads `bucket.bucketName` and `puzzle:publish` discovers
    // it from the `PuzzleBucketName` output (below) — the stack stays the single source of truth,
    // just via the output rather than a literal.
    const bucket = new s3.Bucket(this, 'PuzzleBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // Versioning protects the RETAINed puzzle history: `puzzle:publish` overwrites the
      // same `<date>.<lang>.json` key, so a bad republish would otherwise clobber the live
      // puzzle irrecoverably. Noncurrent versions are pruned after 90 days to bound cost.
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }],
    });

    // ── DynamoDB: per-player daily score rows (#169/#187) ────────────────────
    // One first-write-wins row per (date, lang, mode, publicId) — the day partition IS
    // the population, read back whole by one Query — plus one short-lived HMAC-IP dedup
    // item in its own partition. Every access names its exact keys; no scan or secondary
    // index is needed. The composite (pk, sk) schema replaced #169's single-key
    // bucket-counter table; the retained old table is orphaned and deleted by hand.
    const scoreTable = new dynamodb.Table(this, 'ScoreTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── The ONE index on this table: an account's devices (#216) ─────────────
    // A device item is keyed by SHA-256(its token), so AUTHENTICATION is a direct base-table
    // read and needs no index at all. The sign-out screen asks the opposite question — which
    // devices does THIS account have — and that is what this answers. It is SPARSE: only the
    // device rows carry the two index attributes, so nothing else on the table is in it.
    //
    // It is deliberately OFF the security-sensitive path. A GSI is eventually consistent, so
    // a just-created device may not be listed for a moment and a just-deleted one may still
    // be; neither can keep a revoked token authenticable, because revocation deletes the
    // token's own base item. The base primary key is projected automatically, which is what
    // lets a listed device name the one item to delete.
    // Name and key attributes come from the SHARED contract (the VIEWER_IP_HEADER rule):
    // the backend queries and writes exactly these spellings, and a drift is a
    // production-only ValidationException no local run can reproduce.
    scoreTable.addGlobalSecondaryIndex({
      indexName: DEVICE_INDEX_NAME,
      partitionKey: { name: DEVICE_INDEX_PARTITION_KEY, type: dynamodb.AttributeType.STRING },
      sortKey: { name: DEVICE_INDEX_SORT_KEY, type: dynamodb.AttributeType.STRING },
      // The label the screen renders, and nothing else: a device row carries no secret, but
      // projecting ALL would copy every future attribute into a second copy of the item.
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['deviceId', 'accountId', 'agent', 'createdAt', 'lastSeenAt'],
    });

    // Explicit log group so CloudWatch logs don't accumulate forever (the implicit
    // `/aws/lambda/*` group never expires). DESTROY so teardown is clean; the name is
    // CFN-generated and the function is pointed at it via `logGroup` below.
    const logGroup = new logs.LogGroup(this, 'PuzzleFnLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ── Lambda: the daily-puzzle handler (backend/src/index.ts) ───────────────
    const fn = new NodejsFunction(this, 'PuzzleFn', {
      entry: LAMBDA_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Graviton: cheaper per-ms and typically faster than x86 for this pure-JS handler
      // (no native deps; the AWS SDK ships in the runtime, so the bundle is arch-agnostic).
      architecture: lambda.Architecture.ARM_64,
      // Headroom for the resvg WebAssembly module (compile + a 1200×630 render, #8).
      memorySize: 512,
      timeout: Duration.seconds(10),
      // Cost/abuse ceiling: /og/<token>.png is unauthenticated compute and every distinct
      // token misses the CDN, so cap the blast radius until the game warrants WAF rate
      // limiting. 10 concurrent executions vastly exceeds legitimate load (requests are
      // milliseconds and the CDN absorbs the repeats).
      reservedConcurrentExecutions: 10,
      logGroup,
      // X-Ray active tracing for request-level latency/error visibility.
      tracing: lambda.Tracing.ACTIVE,
      // Read by backend/src/config.ts at runtime.
      environment: {
        PUZZLE_BUCKET: bucket.bucketName,
        SCORE_TABLE: scoreTable.tableName,
        // Names only: AWS::Lambda::Function environment properties do not support
        // CloudFormation's ssm-secure dynamic references. The entrypoint decrypts both at
        // runtime on first use, caches success, and retries a failed read on the next
        // invocation, so no secret value enters this template.
        TURNSTILE_SECRET_PARAMETER: turnstileSecretParameter,
        IP_HMAC_SECRET_PARAMETER: ipHmacSecretParameter,
        ALLOWED_ORIGIN: allowedOrigin,
        // The verified sender #204's link codes go out as.
        MAIL_FROM: mailFrom,
        // Canonical apex for the share card's absolute URLs (#8); omitted (request-origin
        // fallback) when there is no custom domain.
        ...(props.siteOrigin ? { SITE_ORIGIN: props.siteOrigin } : {}),
      },
      depsLockFilePath: REPO_LOCKFILE,
      bundling: {
        // The backend is ESM ("type":"module") and uses `import.meta` — keep it ESM.
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        // The AWS SDK v3 ships in the Node runtime; bundling it only bloats the artifact.
        externalModules: ['@aws-sdk/*'],
        // Copy the share-card assets (resvg .wasm + font) next to the bundle so ogCard.ts's
        // `./assets/*` fs reads resolve at runtime (esbuild bundles resvg-wasm's JS, not the
        // data files it loads). Cross-platform `cp -R`; the bundle dir is fresh each synth.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp -R "${LAMBDA_ASSETS}" "${path.join(outputDir, 'assets')}"`,
          ],
        },
      },
    });

    // Least-privilege: the Lambda may only READ puzzle objects (s3:GetObject). It never
    // writes (publishing is a separate step, #4) and the bucket is never public.
    bucket.grantRead(fn);
    // The submission transaction is one Update (dedup allowance) + one conditional Put
    // (the player's row); reads are one Query over the day partition. The profile row
    // (#188) adds one GetItem (its read) and reuses UpdateItem (its upsert). The friends
    // graph (#189) reuses Query (a player's edge partition) and UpdateItem (the mutual
    // link), and first adds DeleteItem — removal deletes both directions. The friends board
    // (#190) adds BatchGetItem: it reads the score rows of
    // a KNOWN key set instead of paging the whole day partition. A transaction's Get, Put,
    // Update and Delete elements are authorized through those same item permissions (the
    // #204 profile lookup is a `TransactGetItems` and needs nothing beyond the GetItem
    // above), so no Scan surface is needed — but a standalone `ConditionCheck` element is
    // NOT one of them: AWS authorizes it through its OWN action, `dynamodb:ConditionCheckItem`
    // (docs: transaction-apis-iam). #204's adoption asserts rows it does not write — the
    // adopted account, a surviving source, and every guarded no-move of the active day's
    // play — so without it every erasing link is an AccessDeniedException in production
    // and in production only, where no local run or synthesized template can show it. The
    // private history (#211) adds NO action: its calendar is a
    // Query over the caller's own round partition and its solved-day collection a
    // GetItem + UpdateItem on the private player row. Devices (#216) add no action either
    // — authentication is a GetItem, the bootstrap a transaction of two create-only Puts,
    // the sign-out list a Query and revocation a DeleteItem — and no explicit index ARN:
    // a Query against a secondary index is authorized on `<table>/index/*`, which `grant`
    // adds by itself once the table HAS an index (the GSI declared above is the one).
    scoreTable.grant(
      fn,
      'dynamodb:Query',
      'dynamodb:GetItem',
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:ConditionCheckItem',
    );
    const parameterArn = (name: string) =>
      this.formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: name.replace(/^\/+/, ''),
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      });
    // #204's link codes. Scoped to the ONE verified identity this stack owns and, through
    // `ses:FromAddress`, to the ONE address it sends as: a leaked role may not turn this
    // account's reputation into somebody else's mail.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          this.formatArn({ service: 'ses', resource: 'identity', resourceName: props.domainName ?? '*' }),
          this.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: '*' }),
        ],
        conditions: { StringEquals: { 'ses:FromAddress': mailFrom } },
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters'],
        resources: [
          parameterArn(turnstileSecretParameter),
          parameterArn(ipHmacSecretParameter),
        ],
      }),
    );

    // Function URL locked to IAM auth: only CloudFront (via the Origin Access Control
    // wired below) is granted lambda:InvokeFunctionUrl, so the URL is not openly callable.
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ── ACM + Route53 for a stable API domain (only with a custom domain) ─────
    // CloudFront requires the cert in us-east-1; this stack is pinned there (bin/app.ts),
    // so an in-stack acm.Certificate works without a cross-region reference.
    const apiSubdomain = props.apiSubdomain ?? 'api';
    const apiDomain = props.domainName ? `${apiSubdomain}.${props.domainName}` : undefined;
    let apiCertificate: acm.ICertificate | undefined;
    let zone: route53.IHostedZone | undefined;
    if (props.domainName && apiDomain) {
      zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.domainName });
      apiCertificate = new acm.Certificate(this, 'ApiCert', {
        domainName: apiDomain,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      // The DOMAIN identity #204's codes are sent from, with EasyDKIM: passing the hosted
      // zone is what publishes the three DKIM CNAMEs into it, so the records and the
      // identity can never disagree about which key is live. Verification then completes on
      // its own — where an EMAIL identity would need a human to click a link in an inbox
      // nobody owns yet.
      new ses.EmailIdentity(this, 'MailIdentity', {
        identity: ses.Identity.publicHostedZone(zone as route53.IPublicHostedZone),
      });
    }

    // ── Mail plumbing: what comes BACK (#230) ────────────────────────────────
    // #204 gave the game a sender and stopped there. The alarms say a bounce problem
    // exists; the receiving plumbing says WHAT bounced and lets a player write to us at
    // the address the privacy notice already points them at. Both live in lib/mail.ts,
    // which also records why the MX belongs in this stack while SPF and DMARC do not.
    const mailAlerts = props.operatorEmail
      ? new MailAlerts(this, 'MailAlerts', { operatorEmail: props.operatorEmail })
      : undefined;
    if (zone && mailAlerts && props.domainName && props.operatorEmail) {
      new MailReceiving(this, 'MailReceiving', {
        domainName: props.domainName,
        zone: zone as route53.IPublicHostedZone,
        mailFrom,
        forwardTo: props.operatorEmail,
        alerts: mailAlerts,
      });
    }

    // ── CloudFront: CDN in front of the Function URL ──────────────────────────
    // Cache key = request path (`/` vs `/today`) + the `lang`, `date` and `mode` query
    // strings — the puzzle URL is DATE-addressed (the client computes the active 22:00-ET
    // day via the shared day.ts and names it) and `mode` picks which of the two dailies it
    // asks for (#156: absent/`sentence` = the sentence puzzle, `word` = the #154 artifact).
    // The origin drives the TTL via Cache-Control: the
    // puzzle is held long on the CDN (s-maxage; `pnpm puzzle:publish --s3` invalidates on
    // republish) with a short browser max-age, while `/today` (diagnostic) is `no-store`.
    // minTtl 0 lets `no-store`/the short 404 TTL through; maxTtl allows the year-long
    // s-maxage of a date-addressed entry.
    //
    // **Every query string the handler READS has to be listed here.** A cache policy is
    // both halves of the contract: absent an origin request policy — and there is none on
    // this behavior — CloudFront forwards to the origin EXACTLY the values in the cache
    // key, so an unlisted parameter is not merely uncached, it never reaches the Lambda.
    // Leaving `mode` off did both at once: `/?lang&date` and `/?lang&date&mode=word`
    // collapsed onto one entry held for a year, and the origin never saw the mode, so
    // every Word mode request came back as that day's SENTENCE puzzle — which the client
    // rejects as a malformed word artifact. It cannot show up in local development either
    // (`pnpm backend:dev` is the handler with no CDN in front of it), so the rule is
    // written down rather than left to be rediscovered.
    const cachePolicy = new cloudfront.CachePolicy(this, 'PuzzleCachePolicy', {
      cachePolicyName: 'WhippinDailyPuzzle',
      comment:
        'Daily puzzle: cache key = path + ?lang + ?date + ?mode; TTL from origin Cache-Control.',
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('lang', 'date', 'mode'),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // `/scores` is live data: use AWS's managed zero-TTL policy for GET and POST alike.
    // CloudFront rejects a CUSTOM policy whose min/default/max TTL are all zero when that
    // same policy includes any cache-key query strings. Forward the three protocol values
    // through the origin policy instead: they reach Lambda but remain outside a cache key
    // that can never be used.
    const scoreCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

    // The Turnstile-gated WRITES need TWO things at the origin, and no single header mode
    // carries both — which is the whole reason this function exists. It was the score POST
    // when it was written; since #203 that POST is retired and the writes are `/round`'s
    // (both modes' round START verifies a challenge against the connecting address, and a
    // finished round records the score row the POST used to, IP-metered the same way), so
    // the function is associated with BOTH behaviors.
    //
    //  - The viewer's `x-amz-content-sha256`: OAC cannot sign a POST to a Lambda URL
    //    without the exact viewer-computed body hash. CloudFront REFUSES to name any
    //    `x-amz-*` header in an origin-request allow-list ("The parameter Headers contains
    //    x-amz-content-sha256 that is not allowed"), so the only way it reaches the origin
    //    is a mode that forwards viewer headers wholesale.
    //  - The connecting viewer's address, for the handler's HMAC dedup. CloudFront can
    //    GENERATE that as `CloudFront-Viewer-Address`, but a generated header is added only
    //    by the allow-list and "all viewer headers + CloudFront headers" modes — never by
    //    `allExcept`, which AWS documents as "all other HTTP headers IN VIEWER REQUESTS".
    //    The "+ CloudFront headers" mode would carry both, but it also forwards the viewer
    //    Host, and Lambda validates the SigV4 signature against the Function URL's own
    //    domain — so that mode breaks the very POST it was meant to enable.
    //
    // So the policy stays on `allExcept: Host` — AWS's Lambda-URL-safe mode, which carries
    // the payload hash and lets CloudFront set Host to the Function URL's own domain — and
    // this viewer-request function supplies the address as an ORDINARY viewer header that
    // mode already carries for free. The overwrite is what makes it trustworthy: whatever
    // a viewer sends under that name is replaced by CloudFront's own read of the TCP peer.
    // The header NAME is @whippin/shared's, so the CDN and the handler cannot drift.
    //
    // Anyone tempted to "simplify" this back to one policy: an `allExcept: Host` policy
    // ALONE ships a Lambda that throws on every POST (no trusted address), and neither
    // `pnpm backend:dev` nor a synthesized template can show it — only a real edge request.
    const viewerIpFn = new cloudfront.Function(this, 'ScoreViewerIpFn', {
      comment: 'Stamp the connecting viewer address into the live routes\' trusted header.',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          // Unconditional assignment, never a merge: a viewer sending this header must not
          // be able to influence what the origin reads.
          `  request.headers['${VIEWER_IP_HEADER}'] = { value: event.viewer.ip };`,
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    // ONE shape for every LIVE route's origin-request policy (#169/#188/#189/#190), and
    // one spelling of it: `allExcept: Host` headers — AWS's Lambda-URL pattern, the mode
    // that carries the viewer's `x-amz-content-sha256` for an OAC-signed POST while
    // letting CloudFront set Host to the Function URL's own domain for that signature —
    // no cookies, and a query allow-list naming EXACTLY what that route's handler reads.
    // The allow-list is the only per-route value because it is the only per-route
    // DECISION: it is one third of a three-package contract (root AGENTS.md), and an
    // unlisted parameter never reaches the Lambda at all. The header mode is the part
    // that must never drift, which is why four copies of it became one.
    const liveOriginRequestPolicy = (
      id: string,
      policyName: string,
      comment: string,
      queries: readonly string[],
    ) =>
      new cloudfront.OriginRequestPolicy(this, id, {
        originRequestPolicyName: policyName,
        comment,
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList('Host'),
        queryStringBehavior: queries.length
          ? cloudfront.OriginRequestQueryStringBehavior.allowList(...queries)
          : cloudfront.OriginRequestQueryStringBehavior.none(),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      });

    // `id` joined the three addressing queries with #203: the read reports the CALLER's own
    // band, so the handler needs the publicId naming them (never the secret — that would be
    // a query string, which no route here puts one in). An unlisted parameter never reaches
    // the Lambda at all, so the standing would silently go blank for everybody.
    const scoreOriginRequestPolicy = liveOriginRequestPolicy(
      'ScoreOriginRequestPolicy',
      'WhippinLiveScoresOrigin',
      'Live scores: forward exact queries and Lambda-URL-safe headers outside cache.',
      ['lang', 'date', 'mode', 'id'],
    );

    // `/profile` (#188) reads ONE query, the public id a board row resolves by.
    const profileOriginRequestPolicy = liveOriginRequestPolicy(
      'ProfileOriginRequestPolicy',
      'WhippinPlayerProfileOrigin',
      'Player profile: forward the id query and Lambda-URL-safe headers outside cache.',
      ['id'],
    );

    // `/friends` (#189) reads NO query parameter at all — the device token authenticates in
    // the body, so every call is a POST and there is nothing to forward but the headers
    // carrying the OAC-signed body hash. An EMPTY allow-list is the honest statement of
    // that: the day this route grows a query, it has to be named here or CloudFront will
    // strip it before the handler ever sees it.
    const friendsOriginRequestPolicy = liveOriginRequestPolicy(
      'FriendsOriginRequestPolicy',
      'WhippinFriendsOrigin',
      'Friends graph: no query strings, Lambda-URL-safe headers outside cache.',
      [],
    );

    // `/board` (#190) reads FOUR: `lang`/`date`/`mode` address the day's board, and `id`
    // (the caller's PUBLIC id, never the secret) widens the global GET with a
    // below-the-cut window.
    const boardOriginRequestPolicy = liveOriginRequestPolicy(
      'BoardOriginRequestPolicy',
      'WhippinLeaderboardOrigin',
      'Leaderboard: forward the four board queries and Lambda-URL-safe headers outside cache.',
      ['lang', 'date', 'mode', 'id'],
    );

    // `/round` (#201) reads THREE — the same day-addressing triple as /scores, since the
    // guess log is one item per (date, lang, mode, account). The device token travels in
    // the POST body, never in a query.
    const roundOriginRequestPolicy = liveOriginRequestPolicy(
      'RoundOriginRequestPolicy',
      'WhippinRoundOrigin',
      'Round guess log: forward the three addressing queries and Lambda-URL-safe headers outside cache.',
      ['lang', 'date', 'mode'],
    );

    // `/devices` (#216) reads NO query at all — the device token is the auth and it travels
    // in the body, exactly like `/friends`. Same empty-allow-list rule: the day it reads one,
    // it has to be named here or CloudFront will strip it before the handler sees it.
    const devicesOriginRequestPolicy = liveOriginRequestPolicy(
      'DevicesOriginRequestPolicy',
      'WhippinDevicesOrigin',
      'Devices: no query strings, Lambda-URL-safe headers outside cache.',
      [],
    );

    // `/link` (#204) reads NO query at all — the device token is the auth and it travels in
    // the body, exactly like `/friends` and `/devices`. Same empty-allow-list rule: the day
    // it reads one, it has to be named here or CloudFront will strip it before the handler
    // sees it.
    const linkOriginRequestPolicy = liveOriginRequestPolicy(
      'LinkOriginRequestPolicy',
      'WhippinAccountLinkOrigin',
      'Account link: no query strings, Lambda-URL-safe headers outside cache.',
      [],
    );

    // `/history` (#211) reads THREE — `lang`/`mode` name which game, and `month` the
    // calendar page. NOT `date`: this read is addressed by a MONTH, which is exactly the
    // sort-key prefix a player's calendar is one Query over. The device token travels in the
    // POST body like every other private read.
    const historyOriginRequestPolicy = liveOriginRequestPolicy(
      'HistoryOriginRequestPolicy',
      'WhippinPlayerHistoryOrigin',
      'Player history: forward the game + month queries and Lambda-URL-safe headers outside cache.',
      ['lang', 'mode', 'month'],
    );

    // Security response headers for the API. CORS stays owned by the Lambda (it echoes the
    // configured origin + Vary), so this policy adds ONLY transport/sniffing hardening and
    // deliberately sets no CORS/CSP (CSP is a document concern, not a JSON API's).
    const apiHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ApiSecurityHeaders', {
      responseHeadersPolicyName: 'WhippinApiSecurityHeaders',
      comment: 'API: HSTS + nosniff + referrer-policy (CORS owned by the Lambda).',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const functionOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl);

    // ONE association, worn by every behavior whose handler reads a trusted client
    // address. Removing it from `/round` ships a Lambda that throws on every round start,
    // which neither `backend:dev` nor a synthesized template can show — only a real edge
    // request — which is why `backend-stack.test.ts` pins both associations.
    const viewerIpAssociation: cloudfront.FunctionAssociation = {
      function: viewerIpFn,
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
    };

    // ONE shape for every LIVE route's BEHAVIOR too: zero-TTL because the data is live
    // (it must never inherit the puzzle's year-long s-maxage), ALL methods because each
    // of these routes has a write or an authenticated POST, and the route's own
    // origin-request policy from above.
    const liveBehavior = (
      originRequestPolicy: cloudfront.IOriginRequestPolicy,
      overrides: Partial<cloudfront.BehaviorOptions> = {},
    ): cloudfront.BehaviorOptions => ({
      origin: functionOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy,
      responseHeadersPolicy: apiHeaders,
      compress: true,
      ...overrides,
    });

    const distribution = new cloudfront.Distribution(this, 'PuzzleCdn', {
      comment: 'Whippin daily-puzzle API',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // NA + EU (en/fr audience)
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3, // QUIC: faster connection setup
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      domainNames: apiDomain ? [apiDomain] : undefined,
      certificate: apiCertificate,
      defaultBehavior: {
        // OAC: CloudFront signs requests to the IAM-protected Function URL and is the
        // only principal allowed to invoke it.
        origin: functionOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // GET serves puzzles; OPTIONS is the CORS preflight the handler answers (204).
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy,
        responseHeadersPolicy: apiHeaders,
        compress: true,
      },
      // Every LIVE route wears the same behavior — zero-TTL (the data IS live), ALL
      // methods (each has a write or an authenticated POST), and its own origin-request
      // policy. Each pattern also catches a harmless trailing slash; the handler still
      // accepts only the exact normalized route. Two of them differ, by the one thing that
      // is not shared: the viewer-IP function, wanted wherever the handler needs a TRUSTED
      // client address. Since #203 that is `/round` — both modes' Turnstile-gated round
      // START verifies the challenge against it, and a finished round records the day's
      // score row metered by its HMAC — as well as `/scores`, kept because the route's
      // shape is otherwise unchanged. Runs before the cache lookup, so the header it
      // stamps IS a viewer header by the time the origin request policy decides what to
      // forward.
      additionalBehaviors: {
        'scores*': liveBehavior(scoreOriginRequestPolicy, {
          cachePolicy: scoreCachePolicy,
          functionAssociations: [viewerIpAssociation],
        }),
        'profile*': liveBehavior(profileOriginRequestPolicy),
        'board*': liveBehavior(boardOriginRequestPolicy),
        'round*': liveBehavior(roundOriginRequestPolicy, {
          functionAssociations: [viewerIpAssociation],
        }),
        'friends*': liveBehavior(friendsOriginRequestPolicy),
        'history*': liveBehavior(historyOriginRequestPolicy),
        // The device BOOTSTRAP is Turnstile-gated (#216), so this route needs a trusted
        // client address exactly as the round start does — the third behavior wearing the
        // viewer-request function.
        'devices*': liveBehavior(devicesOriginRequestPolicy, {
          functionAssociations: [viewerIpAssociation],
        }),
        // Sending a #204 link code is Turnstile-gated AND metered per address, so this
        // route needs a trusted client address exactly as the round start does — the fourth
        // behavior wearing the viewer-request function.
        'link*': liveBehavior(linkOriginRequestPolicy, {
          functionAssociations: [viewerIpAssociation],
        }),
      },
    });

    // ── Oct-2025 Function URL invoke requirement ──────────────────────────────
    // `withOriginAccessControl` grants CloudFront only `lambda:InvokeFunctionUrl`.
    // Since Oct 2025 AWS requires the service principal to ALSO hold `lambda:InvokeFunction`
    // to invoke a Function URL via OAC — without it CloudFront's signed request is rejected
    // with 403 AccessDeniedException ("Function URL authorization") even though the OAC,
    // auth type, and InvokeFunctionUrl grant are all correct. Function URLs created BEFORE the
    // change are grandfathered, so older deployments keep working; any created after it (this
    // one) need the second grant explicitly. Scope it to this distribution, mirroring the
    // SourceArn condition the construct's own InvokeFunctionUrl grant uses.
    // See aws-samples/remote-swe-agents#361.
    fn.addPermission('CloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/${distribution.distributionId}`,
    });

    // ── Route53: alias the API domain at the distribution ─────────────────────
    // Plain A/AAAA aliases owned by this stack. Once created, redeploys update them in place
    // (CloudFormation UPSERTs records it manages), so they never collide on their own lifecycle.
    // A *foreign* pre-existing `api.<domain>` record (e.g. from an old deployment) would block
    // the first create — clear it once as a migration step rather than relying on the deprecated,
    // delete-then-create `deleteExisting`.
    if (zone && apiDomain) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, 'ApiAliasA', { zone, recordName: apiDomain, target });
      new route53.AaaaRecord(this, 'ApiAliasAAAA', { zone, recordName: apiDomain, target });
    }

    // ── cdk-nag: accepted exceptions (each justified) ─────────────────────────
    NagSuppressions.addResourceSuppressions(
      fn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWS-managed basic-execution + X-Ray-write policies — the standard least-broad managed policies for CloudWatch Logs and active tracing.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 read access is scoped to the puzzle bucket/object keys. DynamoDB is scoped to this table and its indexes — the grant\'s <table>/index/* resource covers exactly the one DeviceByAccount GSI (#216) — with only Query/GetItem/PutItem/UpdateItem/DeleteItem (DeleteItem serves symmetric friend removal, device revocation and #204\'s account erase), and SSM GetParameters to the two exact secret-parameter ARNs; no parameter wildcard exists. ses:SendEmail names this stack\'s own domain identity and is additionally conditioned on the single ses:FromAddress it may send as; the configuration-set wildcard is required by SES on every SendEmail call and grants nothing on its own.',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Runtime is pinned to NODEJS_22_X — the current maintained Node LTS on Lambda — for reproducible builds; we deliberately pin a specific LTS rather than a floating "latest". cdk-nag\'s bundled runtime list lags new LTS releases.',
        },
      ],
      true, // also apply to the function's generated role/policy (children)
    );
    NagSuppressions.addResourceSuppressions(scoreTable, [
      {
        id: 'AwsSolutions-DDB3',
        reason:
          'PITR is intentionally disabled: this table co-locates 48-hour HMAC-IP dedup items, and backups would retain that pseudonymous data beyond the explicit privacy lifetime. Score rows are keyed by a derived publicId with no personal data and accept this recovery tradeoff.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(distribution, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'Daily word game served globally on purpose — no geo restriction.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason:
          'No WAF: the origin is IAM-only via OAC; score writes require Turnstile, validate the puzzle-aware range, and cap HMAC-IP submissions atomically. WAF cost is unjustified at this scale.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason:
          'CloudFront access logging intentionally off (chosen observability tier: Lambda log retention + X-Ray).',
      },
    ]);
    NagSuppressions.addResourceSuppressions(bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'S3 server access logging intentionally off (chosen observability tier); bucket is private (BLOCK_ALL), TLS-enforced, read-only from the Lambda.',
      },
    ]);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new CfnOutput(this, 'ApiUrl', {
      description: 'API base URL the web app calls — set as VITE_API_BASE_URL.',
      value: apiDomain ? `https://${apiDomain}` : `https://${distribution.distributionDomainName}`,
    });
    if (mailAlerts) {
      new CfnOutput(this, 'MailAlertsTopicArn', {
        description:
          'SNS topic behind the SES reputation alarms (#230). Its email subscription must be CONFIRMED by hand before anything is delivered.',
        value: mailAlerts.topic.topicArn,
      });
    }
    new CfnOutput(this, 'PuzzleBucketName', {
      description: 'S3 bucket holding the daily puzzles (upload target for #4).',
      value: bucket.bucketName,
    });
    new CfnOutput(this, 'ScoreTableName', {
      description: 'DynamoDB table holding per-player daily score rows and 48h dedup items.',
      value: scoreTable.tableName,
    });
    new CfnOutput(this, 'FunctionUrl', {
      description: 'Lambda Function URL (CloudFront origin; not called by the web app directly).',
      value: fnUrl.url,
    });
    new CfnOutput(this, 'DistributionDomainName', {
      description: 'CloudFront default domain (Route53 alias target for the API domain).',
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, 'DistributionId', {
      description: 'API CloudFront distribution id (for `aws cloudfront create-invalidation`).',
      value: distribution.distributionId,
    });
  }
}
