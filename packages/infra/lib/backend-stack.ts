import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stack, type StackProps, Duration, CfnOutput, RemovalPolicy, Aws } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
// The Lambda IS the backend package's existing entrypoint (createHandler over the S3
// store); nothing is duplicated here. esbuild bundles it (and @whippin/shared)
// at synth time; @aws-sdk/* is left external (provided by the Node runtime).
const LAMBDA_ENTRY = path.resolve(here, '..', '..', 'backend', 'src', 'index.ts');
const REPO_LOCKFILE = path.resolve(here, '..', '..', '..', 'pnpm-lock.yaml');

export interface BackendStackProps extends StackProps {
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
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup,
      // X-Ray active tracing for request-level latency/error visibility.
      tracing: lambda.Tracing.ACTIVE,
      // Read by backend/src/config.ts at runtime.
      environment: {
        PUZZLE_BUCKET: bucket.bucketName,
        ALLOWED_ORIGIN: allowedOrigin,
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
      },
    });

    // Least-privilege: the Lambda may only READ puzzle objects (s3:GetObject). It never
    // writes (publishing is a separate step, #4) and the bucket is never public.
    bucket.grantRead(fn);

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
    // Cache key = request path (`/` vs `/today`) + the `lang` query string — the ONLY
    // query the handler reads. The origin's Cache-Control (s-maxage aligned to the
    // 22:00-ET flip, see backend/src/handler.ts) drives the actual TTL; minTtl 0 lets a
    // late-published puzzle's short 404 TTL revalidate, maxTtl caps any single entry at
    // one full day (the longest a puzzle stays fresh between flips).
    const cachePolicy = new cloudfront.CachePolicy(this, 'PuzzleCachePolicy', {
      cachePolicyName: 'WhippinDailyPuzzle',
      comment: 'Daily puzzle: cache key = path + ?lang; TTL from origin Cache-Control.',
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('lang'),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

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
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // GET serves puzzles; OPTIONS is the CORS preflight the handler answers (204).
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy,
        responseHeadersPolicy: apiHeaders,
        compress: true,
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
            'bucket.grantRead grants s3:GetObject*/GetBucket* on <bucket>/* — the minimal read surface to fetch daily-puzzle objects by key (wildcard is on object keys, not extra actions).',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Runtime is pinned to NODEJS_22_X — the current maintained Node LTS on Lambda — for reproducible builds; we deliberately pin a specific LTS rather than a floating "latest". cdk-nag\'s bundled runtime list lags new LTS releases.',
        },
      ],
      true, // also apply to the function's generated role/policy (children)
    );
    NagSuppressions.addResourceSuppressions(distribution, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'Daily word game served globally on purpose — no geo restriction.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason:
          'No WAF: the sole origin is an IAM-auth Function URL reachable only via OAC, serving cacheable read-only JSON; WAF cost is unjustified for this surface.',
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
    new CfnOutput(this, 'FunctionUrl', {
      description: 'Lambda Function URL (CloudFront origin; not called by the web app directly).',
      value: fnUrl.url,
    });
    new CfnOutput(this, 'DistributionDomainName', {
      description: 'CloudFront default domain (Route53 alias target for the API domain).',
      value: distribution.distributionDomainName,
    });
  }
}
