import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Stack, type StackProps, Duration, CfnOutput, RemovalPolicy, Annotations } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { GROUP_SEGMENT, SHARE_SEGMENT } from '@whippin/shared';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { NagSuppressions } from 'cdk-nag';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/infra/lib
// The built SPA lives here after `pnpm build`. BucketDeployment zips this directory at
// synth time, so the build MUST run before `cdk deploy` (the README documents the order).
const WEB_DIST = path.resolve(here, '..', '..', 'web', 'dist');

interface WebStackProps extends StackProps {
  // The registered apex domain whose Route53 hosted zone lives in this account
  // (e.g. "chqrles.me"). When omitted, the stack still synthesizes — it just serves the
  // SPA on the default *.cloudfront.net domain with no ACM/Route53 (handy for a smoke
  // synth without AWS credentials). Provide it for the real, custom-domain deploy.
  domainName?: string;
  // Subdomain label for the site under `domainName`. Defaults to "" (the apex,
  // e.g. whippin.ai); set e.g. "play" for play.<domain>. Ignored when `domainName` is unset.
  siteSubdomain?: string;
  // Backend API origin the SPA calls (BackendStack `ApiUrl`, e.g. https://api.whippin.ai).
  // Drives the Content-Security-Policy `connect-src`. Defaults to `https://api.<domainName>`
  // when a domain is set; when neither is available, `connect-src` is just 'self'.
  apiOrigin?: string;
  // The built SPA to publish: `packages/web/dist` unless a test hands its own.
  webDist?: string;
}

// THE ROUTES WITH A PAGE OF THEIR OWN: every `<route>/index.html` in a build, as its route
// (`dist/fr/learn/2/index.html` -> `/fr/learn/2`). The web build writes one per page whose
// link preview is its own (web/src/linkPreviews.ts) — the same shell under another head, so a
// chat app's crawler, which runs no JavaScript, reads the right card. The root index.html is
// the shell itself, and `assets/` and `vocab/` hold files, never pages.
export function builtRoutePages(dist: string): string[] {
  if (!fs.existsSync(dist)) return [];
  const routes: string[] = [];
  const walk = (dir: string, route: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || (route === '' && (entry.name === 'assets' || entry.name === 'vocab'))) continue;
      const child = `${route}/${entry.name}`;
      if (fs.existsSync(path.join(dir, entry.name, 'index.html'))) routes.push(child);
      walk(path.join(dir, entry.name), child);
    }
  };
  walk(dist, '');
  return routes.sort();
}

// Frontend hosting (#21): private S3 bucket holding `packages/web/dist`, served only via
// CloudFront (Origin Access Control) over HTTPS, with SPA fallback. When a custom domain
// is supplied it adds a DNS-validated ACM cert (this stack is pinned to us-east-1, the
// region CloudFront requires) and Route53 A/AAAA aliases. Sibling of BackendStack —
// independently deployable (`cdk deploy WhippinWebStack`). VITE_API_BASE_URL stays the
// backend's `ApiUrl` output; the backend's `allowedOrigin` should be this site's origin.
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps = {}) {
    super(scope, id, props);

    const domainName = props.domainName;
    const subdomain = props.siteSubdomain ?? '';
    // The site's final origin host: the apex (e.g. "whippin.ai") by default, or
    // "<subdomain>.<domain>" when a subdomain is given.
    const siteDomain = domainName ? (subdomain ? `${subdomain}.${domainName}` : domainName) : undefined;
    const webDist = props.webDist ?? WEB_DIST;

    // ── S3: the private SPA bucket ────────────────────────────────────────────
    // Fully private (blocks all public access, enforces TLS, encrypts at rest); reachable
    // only through CloudFront via OAC. Unlike the puzzle bucket this holds nothing but the
    // current build — fully reproducible — so DESTROY + autoDelete makes teardown clean.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── ACM + Route53 (only with a custom domain) ─────────────────────────────
    // The cert must live in us-east-1 for CloudFront; this whole stack is pinned there
    // (see bin/app.ts), so an in-stack acm.Certificate works without cross-region refs.
    let certificate: acm.ICertificate | undefined;
    let zone: route53.IHostedZone | undefined;
    if (domainName && siteDomain) {
      zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName });
      certificate = new acm.Certificate(this, 'SiteCert', {
        domainName: siteDomain,
        validation: acm.CertificateValidation.fromDns(zone),
      });
    }

    // ── Security response headers (HSTS + CSP + sniff/frame/referrer hardening) ─
    // The SPA's only external origins are the backend API,
    // Umami's analytics (#60: its script from cloud.umami.is in script-src, its
    // collection endpoint gateway.umami.is in connect-src — Umami ships no npm tracker),
    // and Cloudflare Turnstile (#170: the invisible score-submission challenge loads its
    // api.js and runs in its own iframe — per Cloudflare's docs it needs exactly
    // script-src + frame-src). Scripts are otherwise 'self' (Vite emits hashed module
    // files, no inline JS);
    // inline styles are allowed because the app sets dynamic `style={{…}}` (e.g.
    // ProgressBar); flags are inlined as data: URIs. CSP MUST be re-verified after deploy —
    // an over-tight policy breaks the page.
    const apiOrigin = props.apiOrigin ?? (domainName ? `https://api.${domainName}` : undefined);
    const umamiScriptOrigin = 'https://cloud.umami.is';
    const umamiCollectOrigin = 'https://gateway.umami.is';
    const turnstileOrigin = 'https://challenges.cloudflare.com';
    const csp = [
      "default-src 'self'",
      `script-src 'self' ${turnstileOrigin} ${umamiScriptOrigin}`,
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      `connect-src 'self'${apiOrigin ? ` ${apiOrigin}` : ''} ${umamiCollectOrigin}`,
      `frame-src ${turnstileOrigin}`,
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    const siteHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SiteSecurityHeaders', {
      responseHeadersPolicyName: 'WhippinSiteSecurityHeaders',
      comment: 'Site: HSTS + CSP + nosniff + frame/referrer hardening.',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          // `preload` left off deliberately: submitting the apex to the HSTS preload list is
          // a one-way door (hard to undo). Enable later if every subdomain is HTTPS-only.
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
      },
    });

    // ── Share-card routes (issue #8): proxy /s/* and /og/* to the backend ──────
    // The card page (/s) must be rendered per token (crawlers don't run JS), and the image
    // (/og) is rendered too, so both are served by the backend Lambda. Routing them under the
    // APEX (this distribution) keeps the shared link on the pretty domain and lets a human who
    // clicks it land on the SPA; the backend builds all card URLs from that same apex origin.
    // The token lives in the PATH, so caching keys on path (CACHING_OPTIMIZED) and honours the
    // backend's `immutable` Cache-Control.
    //
    // The card pages get their OWN headers policy, not the SPA's: the /s page redirects humans
    // with a tiny inline <script>, which the SPA's `script-src 'self'` CSP would block. This
    // trivial, server-rendered redirect stub (all values escaped/sanitized) has no injection
    // surface, so `script-src 'unsafe-inline'` is fine here; HSTS/nosniff/frame stay on.
    const cardHeaders = new cloudfront.ResponseHeadersPolicy(this, 'CardHeaders', {
      responseHeadersPolicyName: 'WhippinCardHeaders',
      comment: 'Share card (#8): HSTS + nosniff/frame; CSP permits the /s inline redirect.',
      // The API answers these with CloudFront's Server-Timing (one fill's timings); this
      // distribution caches them a year, so it would replay that fill to every viewer.
      removeHeaders: ['Server-Timing'],
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
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'",
          override: true,
        },
      },
    });
    const cardBehavior: cloudfront.BehaviorOptions | undefined = apiOrigin
      ? {
          origin: new origins.HttpOrigin(new URL(apiOrigin).host, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: cardHeaders,
          compress: true,
        }
      : undefined;

    // ── SPA fallback: every client route is index.html ────────────────────────
    // A client-routed path (`/en`, `/en/2026-09-01`, `/join/g/<id>`, `/account/email`) has
    // no S3 object, so this viewer-request function hands the bucket `/index.html` for any
    // path whose LAST segment carries no dot — every route the SPA owns — and leaves a file
    // path (`/assets/x.js`, `/vocab/en.json`, `/version.json`) alone, so a missing file is
    // the bucket's own error, never the SPA shell. It runs on the DEFAULT behavior only: a
    // distribution-wide custom error response would also rewrite the API origin's answers
    // on /s, /og and /g, serving a dead invite or share as 200 + the SPA shell and a dead
    // card as HTML.
    //
    // A route the build gave a PAGE OF ITS OWN (`builtRoutePages`: the tutorial's list and
    // its levels) is served that page instead — the same shell wearing its own link preview.
    // The NEAREST such route at or above the path wins, so `/en/learn/3`, a level not ready in
    // English, unfurls as the list the SPA lands it on. The routes ride in the function's
    // source: a viewer-request function cannot ask the bucket what exists.
    const pages = Object.fromEntries(builtRoutePages(webDist).map((route) => [route, 1]));
    const spaFallbackFn = new cloudfront.Function(this, 'SpaFallbackFn', {
      comment: 'Serve a route its own page, or index.html (a last path segment with no dot).',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          `var PAGES = ${JSON.stringify(pages)};`,
          'function handler(event) {',
          '  var request = event.request;',
          "  var last = request.uri.slice(request.uri.lastIndexOf('/') + 1);",
          "  if (last.indexOf('.') !== -1) return request;",
          "  var route = request.uri.replace(/\\/+$/, '');",
          '  while (route) {',
          "    if (PAGES[route]) { request.uri = route + '/index.html'; return request; }",
          "    route = route.slice(0, route.lastIndexOf('/'));",
          '  }',
          "  request.uri = '/index.html';",
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    // ── CloudFront: CDN in front of the private bucket ────────────────────────
    const distribution = new cloudfront.Distribution(this, 'SiteCdn', {
      comment: 'Whippin web front',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // NA + EU (en/fr audience)
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3, // QUIC: faster connection setup
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: 'index.html',
      domainNames: siteDomain ? [siteDomain] : undefined,
      certificate,
      defaultBehavior: {
        // OAC: CloudFront signs requests to the private bucket; the bucket policy (added by
        // S3BucketOrigin) admits only this distribution.
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        // Honours the per-file Cache-Control set by the BucketDeployments below
        // (immutable for hashed assets, SWR for vocab, no-cache for index.html);
        // deploys invalidate '/*'.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: siteHeaders,
        compress: true,
        functionAssociations: [
          { function: spaFallbackFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      // /s/* (card page), /og/* (card image) and /g/* (the #271 group invite link's own
      // preview page, whose card lives under /og/g/) proxy to the backend; everything else
      // is the SPA. The backend's answer reaches the viewer as it is, a dead link's 404
      // included, because the SPA fallback runs on the default behavior alone. The SPA
      // still owns the invite's LANDING, /join/g/<groupId> (shared/invite.ts): the backend
      // page renders the preview and bounces there, so the click's actual work stays
      // client-side. Adding a pattern here TAKES that path away from the SPA — and it must
      // be added to `web/vite.config.ts`'s dev proxy in the same breath, or the path works
      // in exactly one of the two environments.
      additionalBehaviors: cardBehavior
        ? {
            [`/${SHARE_SEGMENT}/*`]: cardBehavior,
            '/og/*': cardBehavior,
            [`/${GROUP_SEGMENT}/*`]: cardBehavior,
          }
        : undefined,
    });

    // ── Route53: alias the site domain at the distribution ────────────────────
    // Plain A/AAAA aliases owned by this stack. Once created, redeploys update them in place
    // (CloudFormation UPSERTs records it manages), so they never collide on their own lifecycle.
    // A *foreign* pre-existing apex/`<siteSubdomain>.<domain>` record (e.g. from an old
    // deployment) would block the first create — clear it once as a migration step rather than
    // relying on the deprecated, delete-then-create `deleteExisting`.
    if (zone && siteDomain) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      new route53.ARecord(this, 'SiteAliasA', { zone, recordName: siteDomain, target });
      new route53.AaaaRecord(this, 'SiteAliasAAAA', { zone, recordName: siteDomain, target });
    }

    // ── Publish the built SPA + invalidate ────────────────────────────────────
    // Several deployments to split cache lifetimes and order the uploads; prune:false so old
    // hashed assets linger for in-flight clients (and so the passes never delete each
    // other's files).
    if (fs.existsSync(webDist)) {
      const source = s3deploy.Source.asset(webDist);
      // The deployment Lambda unzips the bundle and runs `aws s3 sync` in-process; the
      // default 128 MB OOMs on this payload (multi-MB vocab JSON), so give it headroom.
      const memoryLimit = 512;
      // Hashed, content-addressed assets — safe to cache forever.
      const deployAssets = new s3deploy.BucketDeployment(this, 'DeployAssets', {
        sources: [source],
        destinationBucket: bucket,
        prune: false,
        exclude: ['*'],
        include: ['assets/*'],
        cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
        memoryLimit,
      });
      // Vocab JSON: a large, slowly-growing existence set under a STABLE name (not hashed),
      // so it can't be 'immutable'. stale-while-revalidate makes repeat loads instant
      // (served from cache while refreshed in the background) and stale-if-error adds
      // resilience; a deploy still invalidates '/*' below, and a briefly-stale existence set
      // is harmless (a brand-new word just isn't accepted until the background refresh).
      const deployVocab = new s3deploy.BucketDeployment(this, 'DeployVocab', {
        sources: [source],
        destinationBucket: bucket,
        prune: false,
        exclude: ['*'],
        include: ['vocab/*'],
        cacheControl: [
          s3deploy.CacheControl.fromString(
            'public, max-age=300, stale-while-revalidate=604800, stale-if-error=604800',
          ),
        ],
        memoryLimit,
      });
      // The ROUTE PAGES (`<route>/index.html`, `builtRoutePages`): the shell again, so the root
      // set's rule holds for them — they publish after the chunks they name. And they publish
      // BEFORE the fallback function that serves them: the function is a resource of its own,
      // updated as soon as the stack update starts, and a function naming a page the bucket
      // does not hold yet answers that route with the bucket's 403 until the upload lands.
      const deployPages = new s3deploy.BucketDeployment(this, 'DeployPages', {
        sources: [source],
        destinationBucket: bucket,
        prune: false,
        exclude: ['*'],
        include: ['*/index.html'],
        cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
        memoryLimit,
      });
      deployPages.node.addDependency(deployAssets, deployVocab);
      spaFallbackFn.node.addDependency(deployPages);
      // index.html and the remaining unhashed files (fonts, images, version.json) — always
      // revalidate so a redeploy is picked up immediately. Excludes assets/*, vocab/* and the
      // route pages (handled above). This pass carries the CloudFront invalidation that
      // purges every set.
      // `.DS_Store` is excluded because `prune: false` makes any stray upload PERMANENT:
      // one break-glass deploy from a laptop (ALLOW_LOCAL_DEPLOY=1) shipped Finder's
      // `.DS_Store` on 2026-07-26 and it stayed publicly served for a month, since no
      // later deploy can delete what it does not overwrite. CI checkouts never carry the
      // file (it is gitignored), so this guards the local path only — which is exactly
      // the path that has no review in front of it.
      const deployRoot = new s3deploy.BucketDeployment(this, 'DeployRoot', {
        sources: [source],
        destinationBucket: bucket,
        prune: false,
        exclude: ['assets/*', 'vocab/*', '*/index.html', '.DS_Store', '*/.DS_Store'],
        cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
        distribution,
        distributionPaths: ['/*'],
        memoryLimit,
      });
      // The root set MUST publish LAST: version.json is what makes a stale tab reload
      // (web/src/versionCheck.ts) and index.html names the new hashed chunks, so letting
      // CloudFormation run this pass before DeployAssets opens a window where a reloading
      // tab fetches an index whose chunks are not in the bucket yet — a blank page.
      deployRoot.node.addDependency(deployAssets, deployVocab);
    } else {
      Annotations.of(this).addWarning(
        `No build at ${webDist} — run \`pnpm build\` (with VITE_API_BASE_URL set) before \`cdk deploy\`. ` +
          'Synthesizing the stack without uploading the SPA.',
      );
    }

    // ── cdk-nag: accepted exceptions (each justified) ─────────────────────────
    NagSuppressions.addResourceSuppressions(distribution, [
      {
        id: 'AwsSolutions-CFR1',
        reason: 'SPA served globally on purpose — no geo restriction.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason:
          'No WAF: a static SPA on a private S3 origin via OAC, serving public read-only assets; WAF cost is unjustified for this surface.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason: 'CloudFront access logging intentionally off (chosen observability tier).',
      },
    ]);
    NagSuppressions.addResourceSuppressions(bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'S3 server access logging intentionally off; bucket is private (BLOCK_ALL), TLS-enforced, reachable only via CloudFront OAC.',
      },
    ]);
    // Framework-managed custom resources (autoDeleteObjects + the BucketDeployments)
    // use AWS managed policies, wildcard object permissions, and a CDK-pinned runtime — none
    // are authored here and cannot be tightened without forking the constructs.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CDK-managed custom-resource roles (autoDeleteObjects, BucketDeployment) use AWS managed policies.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'CDK-managed custom-resource roles need wildcard s3 permissions on the deployment bucket/objects to sync and invalidate the SPA.',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK-managed custom-resource Lambdas pin their own runtime; not configurable here.',
      },
    ]);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new CfnOutput(this, 'SiteUrl', {
      description: 'Live site URL (set the backend allowedOrigin to this origin).',
      value: siteDomain ? `https://${siteDomain}` : `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'SiteBucketName', {
      description: 'S3 bucket holding the built SPA (packages/web/dist).',
      value: bucket.bucketName,
    });
    new CfnOutput(this, 'DistributionId', {
      description: 'CloudFront distribution id (for manual invalidations).',
      value: distribution.distributionId,
    });
    new CfnOutput(this, 'DistributionDomainName', {
      description: 'CloudFront default domain (target of the Route53 alias).',
      value: distribution.distributionDomainName,
    });
  }
}
