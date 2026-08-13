# AGENTS.md — @whippin/infra (AWS CDK app)

> Package-scoped guidance. The root `AGENTS.md` applies here too — engineering
> principles, workflow, and the CI/CD section, which OWNS the deploy-pipeline-sync
> duty: a new/renamed package or CDK stack must be wired into `deploy.yml`'s
> paths-filter mapping, per-stack jobs, and `workflow_dispatch` options, or it
> silently never deploys. Read it first.

## File map

```
  infra/                      AWS CDK app: backend (#3) + web hosting (#21) sibling stacks (pkg @whippin/infra)
    bin/app.ts                CDK app entry — WhippinBackendStack + WhippinWebStack (cdk.json runs it via `npx tsx`)
    lib/backend-stack.ts      BackendStack: private S3 + DynamoDB + Lambda(Fn URL) + CloudFront; opt api.<domain>; us-east-1
    lib/web-stack.ts          WebStack (#21): private S3 (SPA) + CloudFront(OAC) + ACM + Route53; apex; us-east-1
    lib/deploy-role-stack.ts  DeployRoleStack (#33): GitHub OIDC provider + the CI deploy role; human-deployed
    scripts/guard-local-deploy.mjs  blocks `deploy`/`deploy:app` outside CI (ALLOW_LOCAL_DEPLOY=1 to break glass)
    cdk.json                  CDK config (app command, context)
```

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- **CDK stack (#3):** `packages/infra` (`@whippin/infra`) provisions the backend
  with AWS CDK v2 — one `BackendStack` (`lib/backend-stack.ts`) defining: a **private** S3
  puzzle bucket (all public access blocked, TLS enforced, `RETAIN`; its **name** is
  **CloudFormation-generated, NOT hardcoded** — a fixed physical S3 name is an anti-pattern
  (global-uniqueness collisions, and with `RETAIN` a teardown orphans it so the next deploy
  collides). Nothing consumes the literal name: the Lambda reads `bucket.bucketName` and
  `puzzle:publish` discovers it via the `PuzzleBucketName` output — the stack stays the single
  source of truth for the name, just through the output rather than a `puzzles.<domain>` literal),
  a **`NodejsFunction`**
  that bundles `backend/src/index.ts` with esbuild (ESM, `@aws-sdk/*` left external) and
  carries `PUZZLE_BUCKET`/`ALLOWED_ORIGIN`, and a **CloudFront** distribution in front of an
  **IAM-auth Function URL via OAC** (only CloudFront may invoke it). The Lambda gets
  **read-only** S3 (`bucket.grantRead`) and a **reserved concurrency of 10** (cost/abuse
  ceiling for the unauthenticated `/og` render until WAF is warranted). Cache policy keys
  on path + the `lang`, `date` **and `mode`** query strings and honours the origin
  `Cache-Control`. **Every query string the handler reads must be in that allowList:** with
  no origin request policy on the behavior, CloudFront forwards to the origin exactly the
  cache-key values, so an unlisted parameter never reaches the Lambda AND collapses two
  distinct responses onto one year-long edge entry (`mode` was missing when #156 landed —
  Word mode got the day's sentence puzzle in production while local `backend:dev`, which has
  no CDN, was fine). The puzzle endpoint **requires `date`** (400 otherwise) and is served
  `max-age=300, s-maxage=31536000` (CDN holds it until `puzzle:publish --s3` invalidates);
  `/today` (diagnostic) is `no-store`; maxTtl = 365 days.
  **Score collection (#169)** lives in this SAME stack: one on-demand, AWS-managed-encrypted
  DynamoDB table (string `pk`, `expiresAt` TTL, `RETAIN`), with the Lambda limited to
  `GetItem`/`UpdateItem`; aggregate counters persist while HMAC-IP dedup items expire after
  48h. PITR is deliberately off because a backup would retain those pseudonymous items past
  their privacy lifetime. `/scores` has a separate `scores*` behavior that allows writes, uses a zero-TTL cache
  policy whose allowList is exactly `lang`/`date`/`mode`, and an origin-request policy that
  adds `CloudFront-Viewer-Address` without keying on it. The Lambda receives the table name
  and CloudFormation-resolved SSM SecureStrings (defaults
  `/whippin/turnstile-secret`, `/whippin/ip-hmac-secret`; override with the matching `-c`
  contexts), so no secret value appears in source or the synthesized template.
  Outputs: `ApiUrl` (→ `VITE_API_BASE_URL`), `PuzzleBucketName` (#4 upload target),
  `ScoreTableName`, `FunctionUrl`, `DistributionDomainName`. Commands: `pnpm infra:synth` / `infra:diff` /
  `infra:deploy` (root) or `pnpm --filter @whippin/infra <synth|deploy|diff|destroy>`;
  deploy needs AWS creds + a bootstrapped account. **App deploys go through CI** (PR →
  `ci.yml` → merge → `deploy.yml`); `main` is branch-protected (enforce_admins, require
  PR + the "Typecheck + test" check, strict). So the local `deploy`/`deploy:app` scripts
  are **guarded** by `scripts/guard-local-deploy.mjs`: they refuse unless `CI` is set (CI
  runs `cdk deploy` directly, unaffected) or **`ALLOW_LOCAL_DEPLOY=1`** is passed
  (deliberate break-glass). `synth`/`diff`/`destroy`/`deploy:auth` (the by-hand
  WhippinDeployStack bootstrap) are unguarded. **`-c domainName=<apex>` defaults to
  `whippin.ai`** (`bin/app.ts`), so every cdk command works with no flag; it drives the
  API/site domains and `WebStack` (override `-c domainName=<other>`
  for a different deployment). The API gets the stable custom domain `api.<domain>` (override
  label via `-c apiSubdomain=`): Route53 zone `fromLookup`, a DNS-validated **ACM** cert
  in-stack, distribution alias + **A/AAAA**; `ApiUrl` = `https://api.<domain>`. CORS
  `allowedOrigin` **defaults to the site origin**
  `https://<domain>` (override `-c allowedOrigin=`). The CDK app also defines a sibling
  `WebStack` (below) — pass a stack name to target one. **All three stacks pinned to `us-east-1`**
  (the backend was migrated from `eu-west-1`; tear the old stack down — see infra README).
- **Web hosting stack (#21):** `lib/web-stack.ts` `WebStack` (`WhippinWebStack`) — a sibling
  of `BackendStack`, independently deployable (`cdk deploy WhippinWebStack`), **pinned to
  `us-east-1`** (CloudFront's ACM cert must live there). Hosts the built SPA
  (`packages/web/dist`) on a **private** S3 bucket (`DESTROY` + auto-delete; build is
  reproducible) served only via **CloudFront + OAC** over HTTPS, with **SPA fallback**
  (403/404 → `/index.html`, 200). Two `BucketDeployment`s split cache lifetimes (hashed
  `assets/*` immutable-1yr, everything else `no-cache`) and **invalidate `/*`** on deploy —
  so `pnpm build` must run **before** deploy (missing `dist` → warn + skip upload). Custom
  domain comes from `-c domainName=<apex>` (**defaults to `whippin.ai`** in `bin/app.ts`): it
  looks up the existing Route53 zone (`fromLookup`), issues a DNS-validated **ACM** cert, sets
  the distribution alias to `<siteSubdomain>.<domain>` (`siteSubdomain` default **`""` = apex**;
  set e.g. `play`), and adds **A/AAAA** aliases. (The stack keeps a defensive no-domain
  branch — `*.cloudfront.net`, no ACM/Route53 — only for direct construction.) Wiring: build the web with
  `VITE_API_BASE_URL=https://api.<domain>` (the backend `ApiUrl`); the backend's CORS origin
  defaults to this site's `SiteUrl` (`https://<domain>`). Outputs: `SiteUrl`,
  `SiteBucketName`, `DistributionId`, `DistributionDomainName`.
