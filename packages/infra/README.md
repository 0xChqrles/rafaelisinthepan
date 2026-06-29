# @rafaelisinthepan/infra

AWS **CDK** app with two independent sibling stacks, each deployable on its own
(`cdk deploy RafaelBackendStack` / `cdk deploy RafaelWebStack`):

- **`RafaelBackendStack`** (issue #3) — the daily-puzzle backend (#2).
- **`RafaelWebStack`** (issue #21) — hosting for the web front (`packages/web`).

Both stacks are **pinned to `us-east-1`** (CloudFront's ACM certs must live there, so the
certs stay in-stack with no cross-region reference). A single `-c domainName=<apex>` wires
the custom domains: the **site** serves at the apex (`https://<domain>`) and the **API** at
`https://api.<domain>` (a stable `VITE_API_BASE_URL`), with the backend's CORS origin
defaulting to the site origin. The hosted zone (`<domain>`) must already exist in Route53.

## `RafaelBackendStack` (#3) — daily-puzzle backend

Provisions the backend (#2) so it is reproducible and deployable from one command:

- **S3 puzzle bucket** — private (all public access blocked, TLS enforced, encrypted).
  Holds `<YYYY-MM-DD>.<lang>.json` objects keyed by
  [`backend/src/layout.ts`](../backend/src/layout.ts). Upload target for #4.
- **Lambda + Function URL** — runs the existing backend entrypoint
  [`backend/src/index.ts`](../backend/src/index.ts) (`createHandler` over the S3 store),
  bundled with esbuild at synth time. Reads `PUZZLE_BUCKET` / `ALLOWED_ORIGIN` from the
  environment (set by the stack). Granted **read-only** S3 access; the Function URL is
  **IAM-auth** so only CloudFront can invoke it.
- **CloudFront** — CDN in front of the Function URL via **Origin Access Control**. Cache
  key = request path (`/` vs `/today`) + the `lang` query string; the origin's
  `Cache-Control` (`s-maxage` aligned to the 22:00-ET daily flip) drives the TTL.
- **Custom API domain (optional)** — with `-c domainName=<apex>` the distribution serves at
  `api.<domain>` (override the label with `-c apiSubdomain=`): a DNS-validated ACM cert
  in-stack (this stack is in `us-east-1`) plus Route53 A/AAAA aliases. Without it the API
  stays on its `*.cloudfront.net` domain. `ApiUrl` is the value to use for
  `VITE_API_BASE_URL`.

```
              ┌──────────────┐    OAC (SigV4)   ┌───────────────────┐  s3:GetObject  ┌────────────┐
 viewer  ───▶ │  CloudFront  │ ───────────────▶ │ Lambda (Fn URL,   │ ─────────────▶ │ S3 (private│
  (HTTPS)     │  + cache     │                  │ IAM auth)         │                │  bucket)   │
              └──────────────┘                  └───────────────────┘                └────────────┘
```

## `RafaelWebStack` (#21) — web front hosting

Hosts the built SPA (`packages/web/dist`) on a **private S3 bucket** served only through
**CloudFront** (Origin Access Control) over HTTPS, with **SPA fallback** (403/404 →
`/index.html`, 200). With a custom domain it adds a **DNS-validated ACM certificate** and
**Route53** A/AAAA aliases. The stack is **pinned to `us-east-1`** — the region CloudFront
requires for its ACM cert — so the cert lives in-stack with no cross-region reference.

- **S3 SPA bucket** — private (all public access blocked, TLS enforced, encrypted),
  `RemovalPolicy.DESTROY` + auto-delete: it holds only the current build (fully
  reproducible), so teardown is clean.
- **CloudFront** — HTTPS (`REDIRECT_TO_HTTPS`), `CACHING_OPTIMIZED`, SPA fallback. The
  build is uploaded by two `BucketDeployment`s: hashed `assets/*` get
  `Cache-Control: public, max-age=31536000, immutable`; everything else (`index.html`,
  vocab JSON, fonts) gets `no-cache`. Each deploy **invalidates `/*`**.
- **Custom domain (optional)** — pass `-c domainName=<apex>` (the Route53 hosted zone must
  already exist in the account). The site serves at the **apex** (`<domain>`) by default;
  pass `-c siteSubdomain=play` for `play.<domain>`. Without `domainName` the stack still
  synthesizes/deploys on the default `*.cloudfront.net` domain (no ACM/Route53) — handy for
  a credential-free smoke synth.

> **Build before deploy.** `cdk deploy RafaelWebStack` zips `packages/web/dist` at synth
> time, so run `pnpm build` first (with `VITE_API_BASE_URL` set, see *Wiring* below). If
> `dist` is absent the stack still deploys but **skips the upload** with a warning.

### Wiring the two stacks

The stable custom domains break the chicken-and-egg: both URLs are known up front from
`domainName`, so there is no back-and-forth. The site is `https://<domain>`, the API is
`https://api.<domain>`, and the backend's CORS `allowedOrigin` **defaults to the site
origin** (override with `-c allowedOrigin=`).

```bash
# 1. Backend → api.<domain> (CORS defaults to https://<domain>).
pnpm --filter @rafaelisinthepan/infra deploy RafaelBackendStack -c domainName=whippin.ai
# 2. Build the web. `VITE_API_BASE_URL` comes from the committed
#    packages/web/.env.production (https://api.whippin.ai) — no inline env needed.
pnpm build
# 3. Deploy the site at the apex (uploads dist, invalidates CloudFront).
pnpm --filter @rafaelisinthepan/infra deploy RafaelWebStack -c domainName=whippin.ai
```

The ACM certs are DNS-validated against the `whippin.ai` hosted zone, so the first deploy of
each stack waits for the `CNAME` validation records it creates (a few minutes).

## Commands

Run from this package (or the repo root via `pnpm infra:*`). The app command in
`cdk.json` runs the app through `npx tsx bin/app.ts`, so no compile step is needed. Pass a
**stack name** to target one (omit it to act on both):

```bash
pnpm --filter @rafaelisinthepan/infra synth      # synthesize CloudFormation (also `pnpm infra:synth` from root)
pnpm --filter @rafaelisinthepan/infra diff       # diff against the deployed stack(s) (`pnpm infra:diff`)
pnpm --filter @rafaelisinthepan/infra deploy      # deploy                            (`pnpm infra:deploy`)
pnpm --filter @rafaelisinthepan/infra destroy     # tear down (the puzzle bucket is RETAINed)
pnpm --filter @rafaelisinthepan/infra typecheck   # tsc --noEmit

# Target a single stack (args pass straight through to cdk):
pnpm --filter @rafaelisinthepan/infra deploy RafaelBackendStack -c domainName=whippin.ai
pnpm --filter @rafaelisinthepan/infra deploy RafaelWebStack     -c domainName=whippin.ai
```

Deploying needs AWS credentials in the environment and a **bootstrapped** account/region
(`npx cdk bootstrap` once for `us-east-1`). With `-c domainName`, both stacks resolve the
domain's **Route53 hosted zone** (which must already exist) via `HostedZone.fromLookup`,
caching the result into `cdk.context.json`.

## Outputs

`cdk deploy` prints, per stack:

**`RafaelBackendStack`**

| output                   | use                                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| `ApiUrl`                 | API base URL the web app calls — `https://api.<domain>` — set as `VITE_API_BASE_URL`. |
| `PuzzleBucketName`       | the S3 bucket to publish puzzles into (`pnpm puzzle:publish --s3`).        |
| `FunctionUrl`            | the Lambda Function URL (CloudFront origin; not called directly).         |
| `DistributionDomainName` | the CloudFront default domain (Route53 alias target for `api.<domain>`).   |

**`RafaelWebStack`**

| output                   | use                                                          |
| ------------------------ | ------------------------------------------------------------ |
| `SiteUrl`                | the live site URL — set the backend `allowedOrigin` to it.   |
| `SiteBucketName`         | the S3 bucket holding the built SPA.                         |
| `DistributionId`         | the CloudFront distribution id (manual invalidations).       |
| `DistributionDomainName` | the CloudFront default domain (Route53 alias target).        |

## Migrating the backend to `us-east-1`

The backend was originally deployed to `eu-west-1`; both stacks are now pinned to
`us-east-1` (so `api.<domain>`'s ACM cert lives in-stack). To move an existing backend:

```bash
# 1. Deploy the backend in us-east-1 (new bucket + Fn URL + CloudFront under api.<domain>).
pnpm --filter @rafaelisinthepan/infra deploy RafaelBackendStack -c domainName=whippin.ai
# 2. Tear down the old eu-west-1 stack once the new one is serving.
AWS_REGION=eu-west-1 pnpm --filter @rafaelisinthepan/infra destroy RafaelBackendStack
```

The old `eu-west-1` puzzle bucket is `RETAIN`ed, so step 2 leaves it behind — delete it
manually (`aws s3 rb s3://<old-bucket> --force --region eu-west-1`) once you have confirmed
nothing of value remains. Re-publish puzzles to the new bucket with `pnpm puzzle:publish --s3`.

## Notes

- The **puzzle** bucket uses `RemovalPolicy.RETAIN` — `destroy` leaves it (and its puzzles)
  in place so a teardown never drops history; delete it manually if you really mean to. The
  **SPA** bucket uses `DESTROY` (the build is reproducible), so it is removed on teardown.
- Bundling uses local **esbuild** (an esbuild dev dependency here); no Docker required.
- `@aws-sdk/*` is left external — the Node 22 Lambda runtime already provides AWS SDK v3.
