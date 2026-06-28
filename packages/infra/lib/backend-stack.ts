import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stack, type StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/infra/lib
// The Lambda IS the backend package's existing entrypoint (createHandler over the S3
// store); nothing is duplicated here. esbuild bundles it (and @rafaelisinthepan/shared)
// at synth time; @aws-sdk/* is left external (provided by the Node runtime).
const LAMBDA_ENTRY = path.resolve(here, '..', '..', 'backend', 'src', 'index.ts');
const REPO_LOCKFILE = path.resolve(here, '..', '..', '..', 'pnpm-lock.yaml');

export interface BackendStackProps extends StackProps {
  // The exact web origin permitted to read the API via CORS. Defaults to "*".
  allowedOrigin?: string;
}

export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps = {}) {
    super(scope, id, props);

    const allowedOrigin = props.allowedOrigin ?? '*';

    // ── S3: the private puzzle bucket ─────────────────────────────────────────
    // Holds the `<YYYY-MM-DD>.<lang>.json` objects keyed by backend/src/layout.ts
    // (`storeKey`) — the upload target for #4. Fully private: blocks all public
    // access, enforces TLS, encrypts at rest. RETAIN so tearing down the stack never
    // drops accumulated puzzle history.
    const bucket = new s3.Bucket(this, 'PuzzleBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── Lambda: the daily-puzzle handler (backend/src/index.ts) ───────────────
    const fn = new NodejsFunction(this, 'PuzzleFn', {
      entry: LAMBDA_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
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

    // ── CloudFront: CDN in front of the Function URL ──────────────────────────
    // Cache key = request path (`/` vs `/today`) + the `lang` query string — the ONLY
    // query the handler reads. The origin's Cache-Control (s-maxage aligned to the
    // 22:00-ET flip, see backend/src/handler.ts) drives the actual TTL; minTtl 0 lets a
    // late-published puzzle's short 404 TTL revalidate, maxTtl caps any single entry at
    // one full day (the longest a puzzle stays fresh between flips).
    const cachePolicy = new cloudfront.CachePolicy(this, 'PuzzleCachePolicy', {
      cachePolicyName: 'RafaelDailyPuzzle',
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

    const distribution = new cloudfront.Distribution(this, 'PuzzleCdn', {
      comment: 'Rafael daily-puzzle API',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // NA + EU (en/fr audience)
      defaultBehavior: {
        // OAC: CloudFront signs requests to the IAM-protected Function URL and is the
        // only principal allowed to invoke it.
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // GET serves puzzles; OPTIONS is the CORS preflight the handler answers (204).
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy,
        compress: true,
      },
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new CfnOutput(this, 'ApiUrl', {
      description: 'CloudFront URL the web app calls — set as VITE_API_BASE_URL.',
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'PuzzleBucketName', {
      description: 'S3 bucket holding the daily puzzles (upload target for #4).',
      value: bucket.bucketName,
    });
    new CfnOutput(this, 'FunctionUrl', {
      description: 'Lambda Function URL (CloudFront origin; not called by the web app directly).',
      value: fnUrl.url,
    });
  }
}
