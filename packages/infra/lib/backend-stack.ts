import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Stack,
  type StackProps,
  Duration,
  CfnOutput,
  RemovalPolicy,
  Aws,
  SecretValue,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
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
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { NagSuppressions } from 'cdk-nag';

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
  // Existing SSM SecureString parameters. CloudFormation resolves them into the encrypted
  // Lambda environment at deploy time; their plaintext is never committed or synthesized.
  turnstileSecretParameter?: string;
  ipHmacSecretParameter?: string;
}

export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps = {}) {
    super(scope, id, props);

    const allowedOrigin = props.allowedOrigin ?? '*';

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

    // ── DynamoDB: anonymous daily score histograms (#169) ────────────────────
    // One aggregate item per (date, lang, mode), plus one short-lived HMAC-IP dedup item.
    // Every access names its exact partition key; no scan or secondary index is needed.
    const scoreTable = new dynamodb.Table(this, 'ScoreTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
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
        // Dynamic SSM secure references: CloudFormation resolves these only while writing
        // the Lambda configuration; `cdk synth` contains parameter names, never values.
        TURNSTILE_SECRET: SecretValue.ssmSecure(
          props.turnstileSecretParameter ?? '/whippin/turnstile-secret',
        ).unsafeUnwrap(),
        IP_HMAC_SECRET: SecretValue.ssmSecure(
          props.ipHmacSecretParameter ?? '/whippin/ip-hmac-secret',
        ).unsafeUnwrap(),
        ALLOWED_ORIGIN: allowedOrigin,
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
    // The transaction contains two Update actions, and the response is one GetItem. AWS
    // authorizes transactional actions through their underlying item permissions, so no
    // Scan/Query/Put/Delete surface is needed.
    scoreTable.grant(fn, 'dynamodb:GetItem', 'dynamodb:UpdateItem');

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

    // `/scores` is live data: zero TTL for GET and POST alike. The cache policy still owns
    // the exact query allow-list because, without it, CloudFront strips those values before
    // the Lambda sees them even when caching is disabled.
    const scoreCachePolicy = new cloudfront.CachePolicy(this, 'ScoreCachePolicy', {
      cachePolicyName: 'WhippinLiveScores',
      comment: 'Live score histogram: forward lang/date/mode and never cache.',
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('lang', 'date', 'mode'),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
    });

    // Viewer address is generated by CloudFront from the actual connection and forwarded
    // outside the cache key. The IAM-only Function URL makes it a trusted HMAC input; a
    // viewer-supplied X-Forwarded-For chain is deliberately ignored by the handler.
    const scoreOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'ScoreOriginRequestPolicy',
      {
        originRequestPolicyName: 'WhippinLiveScoresOrigin',
        comment: 'Add the trusted CloudFront viewer address for anonymous score dedup.',
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          'CloudFront-Viewer-Address',
        ),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      },
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
      additionalBehaviors: {
        // `scores*` also catches a harmless trailing slash; the handler still accepts only
        // the exact normalized `/scores` route.
        'scores*': {
          origin: functionOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: scoreCachePolicy,
          originRequestPolicy: scoreOriginRequestPolicy,
          responseHeadersPolicy: apiHeaders,
          compress: true,
        },
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
            'S3 read access is scoped to the puzzle bucket/object keys. DynamoDB is scoped to this table with only GetItem/UpdateItem; the resource has no index wildcard.',
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
          'PITR is intentionally disabled: this table co-locates 48-hour HMAC-IP dedup items, and backups would retain that pseudonymous data beyond the explicit privacy lifetime. Aggregate counters are anonymous and accept this recovery tradeoff.',
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
    new CfnOutput(this, 'PuzzleBucketName', {
      description: 'S3 bucket holding the daily puzzles (upload target for #4).',
      value: bucket.bucketName,
    });
    new CfnOutput(this, 'ScoreTableName', {
      description: 'DynamoDB table holding anonymous daily score counters and 48h dedup items.',
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
