# AGENTS.md — @whippin/infra (AWS CDK app)

> Package-scoped guidance. The root `AGENTS.md` applies here too — engineering
> principles, workflow, and the CI/CD section, which OWNS the deploy-pipeline-sync
> duty: a new/renamed package or CDK stack must be wired into `deploy.yml`'s
> paths-filter mapping, per-stack jobs, and `workflow_dispatch` options, or it
> silently never deploys. Read it first.

## File map

```
  infra/                      AWS CDK app: backend (#3) + web hosting (#21) + WhatsApp bot (#236) sibling stacks (pkg @whippin/infra)
    bin/app.ts                CDK app entry — WhippinBackendStack + WhippinWebStack + WhippinBotStack (cdk.json runs it via `npx tsx`)
    lib/bot-stack.ts          BotStack (#236): bot table + outbound SQS + ONE Fargate task (public subnet, no NAT, no
                              ingress) + podium Lambda with one Scheduler schedule per configured group + alarms.
                              Its groups come from `whatsapp-bot/groups/local/`, the gitignored SNAPSHOT
                              `pnpm bot:groups pull` writes from SSM (group JIDs are not committed — this repo is
                              public). Absent/empty is a legitimate synth, since every cdk command here constructs
                              this stack; an empty one raises a synth WARNING, and `deploy-bot` pulls first.
    lib/bot-stack.test.ts     synthesized contract: one task stop-before-start, no secrets in env, one schedule per
                              enabled group in its own time zone, alarms treat silence as down, and NO cdk-nag
                              finding — `bin/app.ts` runs nag, where a finding is a failed synth
    vitest.config.ts          excludes `cdk.out/**`: the image asset stages the repo root, so a local synth
                              leaves copies of other packages' tests there for the default glob to collect
    lib/backend-stack.ts      BackendStack: private S3 + DynamoDB + Lambda(Fn URL) + CloudFront; opt api.<domain>; us-east-1
    lib/backend-stack.test.ts synthesized score-boundary contract (SSM names/IAM + deployable zero-cache/OAC policies) + the #230 mail shape
    lib/mail.ts               MailAlerts (SNS + SES reputation alarms) + MailReceiving (MX, rule set, S3, forwarder) — #230
    lib/web-stack.ts          WebStack (#21): private S3 (SPA) + CloudFront(OAC) + ACM + Route53; apex; us-east-1
    lib/deploy-role-stack.ts  DeployRoleStack (#33): GitHub OIDC provider + the CI deploy role; human-deployed
                              — also the READ on `/whippin/bot/groups/*`, which `deploy-bot` pulls before it builds
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
  **Score collection (#169; per-player rows #187)** lives in this SAME stack: one
  on-demand, AWS-managed-encrypted DynamoDB table (composite string `pk`/`sk`, `expiresAt`
  TTL, `RETAIN`), with the Lambda limited to `Query`/`PutItem`/`UpdateItem` — one Query
  reads a daily's whole `(date, lang, mode)` partition of per-player rows, the submission
  transaction is a conditional Put (the first-write-wins row, sort key = publicId) plus a
  conditional Update (the dedup allowance). Score rows persist while HMAC-IP dedup items
  expire after 48h. Adding the sort key REPLACED #169's single-key table (2026-08-19): the
  retained old bucket-counter table is orphaned and deleted by hand. PITR is deliberately
  off because a backup would retain the pseudonymous dedup items past their privacy
  lifetime. `/scores` has a separate `scores*` behavior that allows writes
  and uses AWS's managed zero-TTL `CachingDisabled` policy. Its origin-request policy
  forwards exactly the `lang`/`date`/`mode`/`id` queries outside the unused cache key (`id`
  since #203: the read reports the CALLER's own band) and uses
  CloudFront's `allExcept: Host` header mode — the AWS Lambda-URL pattern, which carries the
  viewer's `x-amz-content-sha256` (mandatory for OAC to sign a Lambda-URL POST) and lets
  CloudFront set Host to the Function URL's own domain for that signature. CloudFront rejects
  both a fully-zero custom cache policy with cache-key values and an origin allow-list that
  explicitly names a reserved `x-amz-*` header, so neither narrower-looking representation
  is deployable. **`allExcept` carries NO CloudFront-generated header**, so a
  `ScoreViewerIpFn` viewer-request FUNCTION stamps the connecting address into
  `@whippin/shared`'s `VIEWER_IP_HEADER` instead — see the root `AGENTS.md` for why no single
  header mode can serve both halves. Removing that function ships a Lambda that throws on
  every gated write, which neither `backend:dev` nor a synthesized template can show;
  `backend-stack.test.ts` pins the associations and the stamp. **Since #203 it is
  associated with `/round` as well** — both modes' Turnstile-gated round START verifies the
  challenge against the connecting address, and a finished round records the day's score
  row metered by its HMAC (the score POST that used to do that is retired). Its absence
  there was already a latent 500 on every #202 word round start. **`/profile` (#188)** has
  its own `profile*` behavior on the same shape: `CachingDisabled`, ALLOW_ALL methods,
  and an origin-request policy forwarding exactly the `id` query (the one parameter the
  profile handler reads) with `allExcept: Host` headers for the OAC-signed POST — no
  viewer-IP function, since the route has no per-IP logic. **`/friends` (#189)** is the
  third behavior on that shape — `CachingDisabled`, ALLOW_ALL methods, `allExcept: Host`
  headers for the OAC-signed POST — with a query allow-list that is EMPTY, because the
  handler reads no query at all (the key authenticates in the body); the day it reads one,
  it has to be named there or CloudFront will strip it. **`/board` (#190)** is the fourth:
  `CachingDisabled`, ALLOW_ALL methods (the friends-board read is an authenticated POST),
  `allExcept: Host` headers, and an origin-request allow-list of exactly the FOUR queries
  the board handler reads (`lang`/`date`/`mode`/`id`) — no viewer-IP function, no per-IP
  logic. **`/round` (#201/#203)** is the fifth behavior on that shape — `CachingDisabled`,
  ALLOW_ALL methods (the route is POST-only; the player key authenticates in the body),
  `allExcept: Host` headers, and an origin-request allow-list of exactly the THREE
  addressing queries (`lang`/`date`/`mode`) — plus, since #203, the viewer-IP function,
  because this is now the route with per-address logic (see above). **`/history` (#211)** is
  the sixth and last on that shape — `CachingDisabled` (a player's own history is live AND
  private, so it must never sit at the edge), ALLOW_ALL methods (POST-only; the key
  authenticates in the body), `allExcept: Host` headers, and an allow-list of exactly
  `lang`/`mode`/`month` — NOT `date`, because this read is addressed by a MONTH, which is the
  sort-key prefix #203 reordered the round key for; no viewer-IP function, no per-address
  logic. It adds NO table action: its calendar is a Query over the caller's own round
  partition and its solved-day collection a GetItem + UpdateItem on the private player row.
  **`/devices` (#216)** is the seventh on that shape — `CachingDisabled` (identity is live
  AND a device list is private), ALLOW_ALL methods (POST-only; the device token authenticates
  in the body), `allExcept: Host` headers, an allow-list that is EMPTY because the handler
  reads no query at all (the `/friends` rule), and the viewer-IP function, because the
  Turnstile-gated BOOTSTRAP needs a trusted address exactly as a round start does. It brings
  this table's **ONE secondary index**, `DeviceByAccount` (`gsi1pk`/`gsi1sk`, projecting the
  device row's label fields): authentication is a direct base-table read by the token's hash,
  so the index exists only for the sign-out screen's "which devices does this account have".
  DynamoDB projects the base primary key automatically; `/devices` returns its digest as the
  opaque revocation handle, so the subsequent delete addresses the base item directly and
  never depends on a second eventually-consistent query.
  It adds no table action either — `Table.grant` extends to `<table>/index/*` by itself once
  the table has an index — and `backend-stack.test.ts` pins the index's keys, its projection
  and the behavior's three-package allow-list.
  The table grant adds
  `GetItem` for the profile read (the upsert reuses `UpdateItem`) and **`DeleteItem` for
  #189's symmetric friend removal and #216's device revocation**; all are pinned by
  `backend-stack.test.ts`. The Lambda
  receives the table name and SSM SecureString PARAMETER NAMES (defaults
  `/whippin/turnstile-secret`, `/whippin/ip-hmac-secret`; override with the matching `-c`
  contexts), reads both decrypted values together on first use, caches a successful result,
  retries a failed read on the next invocation, and has `ssm:GetParameters` only on those
  exact ARNs. No secret value appears in source or the synthesized template.
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
  (403/404 → `/index.html`, 200). **Three path patterns are handed to the API origin
  instead of the bucket** — `/s/*` (the share page), `/og/*` (every card image) and,
  since 2026-08-20, `/i/*` (#189's invite link, which the backend renders so it unfurls
  as the sender's own mark and name; its card sits under `/og/i/`). Adding a pattern here
  TAKES that path away from the SPA, which is exactly why the invite's landing moved to
  `/join/<publicId>` — see `shared/src/invite.ts` and the root `AGENTS.md`. Three `BucketDeployment`s split cache lifetimes (hashed
  `assets/*` immutable-1yr, `vocab/*` SWR, everything else `no-cache`) and **invalidate
  `/*`** on deploy — so `pnpm build` must run **before** deploy (missing `dist` → warn +
  skip upload). **The root set (index.html + version.json) publishes LAST** — an explicit
  `addDependency` on the other two, because `version.json` is the web's stale-tab reload
  trigger (`web/src/versionCheck.ts`) and index.html names the new hashed chunks: without
  the ordering, a tab reloading mid-deploy can fetch an index whose chunks are not in the
  bucket yet. Custom
  domain comes from `-c domainName=<apex>` (**defaults to `whippin.ai`** in `bin/app.ts`): it
  looks up the existing Route53 zone (`fromLookup`), issues a DNS-validated **ACM** cert, sets
  the distribution alias to `<siteSubdomain>.<domain>` (`siteSubdomain` default **`""` = apex**;
  set e.g. `play`), and adds **A/AAAA** aliases. (The stack keeps a defensive no-domain
  branch — `*.cloudfront.net`, no ACM/Route53 — only for direct construction.) Wiring: build the web with
  `VITE_API_BASE_URL=https://api.<domain>` (the backend `ApiUrl`); the backend's CORS origin
  defaults to this site's `SiteUrl` (`https://<domain>`). Outputs: `SiteUrl`,
  `SiteBucketName`, `DistributionId`, `DistributionDomainName`.
- **Mail plumbing (#230):** `lib/mail.ts`, two constructs inside `BackendStack`, both gated on
  `-c operatorEmail=` (no default — a personal address in a public repo; CI passes the
  `OPERATOR_EMAIL` repository variable and FAILS the backend deploy when it is unset, since
  2026-09-03's PR-233 review). **`MailAlerts`** — an SNS
  topic (`enforceSSL`, deliberately NOT SSE: a CloudWatch alarm cannot publish through the
  AWS-managed `alias/aws/sns` key, so encryption with the free key would silently break the
  notification), a confirmed-by-hand email subscription, and `AWS/SES`
  `Reputation.BounceRate`/`ComplaintRate` alarms at AWS's own review rates (0.05 / 0.001),
  Maximum over an hour, missing data IGNORED (state held — `notBreaching` would mail a false
  recovery the moment a paused account stopped emitting; same review). The topic policy NAMES
  `cloudwatch.amazonaws.com`, because `enforceSSL` replaces the default policy and would
  otherwise leave a lone Deny. **`MailReceiving`** — the apex `MX` at
  `inbound-smtp.<region>.amazonaws.com`, a private `DESTROY` landing bucket whose `inbound/`
  prefix expires after 30 days (the number the privacy notice states as "about" — S3 rounds
  expiry up to the next UTC midnight and deletes asynchronously), a receipt rule set for
  `hello@`/`abuse@`/`postmaster@`/`dmarc@` running **S3 then Lambda in that order** (the
  forwarder reads what the S3 action wrote), and a second `NodejsFunction` bundling
  `backend/src/mailForward.ts` with `ses:SendEmail` + `ses:SendRawEmail` on `identity/*`,
  conditioned on the one `ses:FromAddress` like the code sender's (NOT "scoped exactly" as
  it was — corrected 2026-09-03 by the first real message: a raw send is authorized as the
  raw action, and SES evaluates the statement against a recipient that is a verified
  identity, which the operator's address is).
  An `AwsCustomResource` ACTIVATES the rule set — SES holds one active rule set per region and
  exposes no CloudFormation property for it, so a deploy without it receives nothing — and the
  forwarder's failures alarm onto the same topic: its `Errors`, AND Lambda's
  `AsyncEventsDropped` (an async event that aged out while THROTTLED under the reserved
  concurrency of 5 is dropped, not errored — same review), with the topic as the function's
  `onFailure` destination so the dropped event, which names the message, lands beside the
  alarm. `backend-stack.test.ts` pins the
  thresholds, the missing-data policies, the CloudWatch publish grant, the MX target, the
  four recipients, the action order, the activation, the retention, the dropped-event alarm
  and destination, and that NONE of it is built without an operator address. Output: `MailAlertsTopicArn`. Operator steps (README): confirm the SNS
  subscription, publish `rua=`, and SES sandbox exit.
