# AGENTS.md — @whippin/infra (AWS CDK app)

> Package-scoped guidance. The root `AGENTS.md` applies here too — engineering
> principles, workflow, and the CI/CD section, which OWNS the deploy-pipeline-sync
> duty: a new/renamed package or CDK stack must be wired into `deploy.yml`'s
> paths-filter mapping, per-stack jobs, and `workflow_dispatch` options, or it
> silently never deploys. Read it first.

## File map

```
  infra/                      AWS CDK app: backend (#3) + web hosting (#21) + WhatsApp bot (#236) sibling stacks (pkg @whippin/infra)
    bin/app.ts                CDK app entry — WhippinBackendStack + WhippinWebStack + WhippinBotStack + WhippinDeployStack
                              (cdk.json runs it via `npx tsx`)
    lib/bot-stack.ts          BotStack (#236): bot table + outbound SQS + ONE Fargate task (public subnet, no NAT, no
                              ingress) + podium Lambda with one Scheduler schedule per configured group + alarms.
                              A schedule's construct id carries a short SHA-256 of its group's JID, never the
                              JID: `cdk deploy` prints logical ids in the CI log, which is public.
                              Its groups come from `whatsapp-bot/groups/local/`, the gitignored SNAPSHOT
                              `pnpm bot:groups pull` writes from SSM (group JIDs are not committed — this repo is
                              public). Absent/empty is a legitimate synth, since every cdk command here constructs
                              this stack; an empty one raises a synth WARNING, and `deploy-bot` pulls first.
    lib/bot-stack.test.ts     synthesized contract: one task stop-before-start, no secrets in env, one schedule per
                              enabled group in its own time zone, no JID in a logical id, alarms treat silence as
                              down, and NO cdk-nag finding — `bin/app.ts` runs nag, where a finding is a failed synth
    vitest.config.ts          excludes `cdk.out/**`: the image asset stages the repo root, so a local synth
                              leaves copies of other packages' tests there for the default glob to collect
    lib/backend-stack.ts      BackendStack: private S3 + DynamoDB + Lambda(Fn URL) + CloudFront; opt api.<domain>; us-east-1
    lib/backend-stack.test.ts synthesized score-boundary contract (SSM names/IAM + deployable zero-cache/OAC policies)
                              + every live behavior's edge function, RUN (the preflight against `preflightHeaders`,
                              the viewer-IP stamp) + the #230 mail shape + cdk-nag
    lib/web-stack.test.ts     synthesized contract: the three API-routed path patterns, the SPA fallback (a
                              default-behavior function run against sample paths, the routes with a page of their
                              own included; no error responses), the route-page scan, the upload order (a fake
                              build), the CSP, cdk-nag
    lib/deploy-role-stack.test.ts  cdk-nag over the deploy role stack
    lib/rate-limits.ts        the per-IP WAF rate rules each distribution wears (which paths, what limit)
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
  **read-only** S3 (`bucket.grantRead`), a **reserved concurrency of 200** (the cost
  ceiling — the unauthenticated card renders miss the CDN per token; one address is stopped
  long before it by the WAF limits below; the account's 400 keeps the 100 unreserved AWS
  requires) and **1769 MB** — one
  full vCPU, since what is slow there is CPU (the cold start, the artifact's parse, the
  puzzle's brotli, the card render) and Node runs a request on one core. The API's response
  headers policy carries CloudFront's `Server-Timing` on every response
  (`serverTimingSamplingRate: 100`), the edge→origin timings a browser's network panel
  shows; the web distribution's card routes strip it (`removeHeaders`), so a year-cached share
  page never replays one fill's timings. Cache policy keys
  on path + the `lang`, `date` and `bonus` query strings and honours the origin
  `Cache-Control`. **Every query string the handler reads must be in that allowList:** with
  no origin request policy on the behavior, CloudFront forwards to the origin exactly the
  cache-key values, so an unlisted parameter never reaches the Lambda AND collapses two
  distinct responses onto one year-long edge entry — which local `backend:dev`, having no
  CDN, cannot show. The puzzle endpoint **requires `date`** or `bonus` (400 otherwise) and is served
  `max-age=300, s-maxage=31536000` (CDN holds it until `puzzle:publish --s3` invalidates);
  `/today` (diagnostic) is `no-store`; maxTtl = 365 days.
  **Score collection (#169; per-player rows #187)** lives in this SAME stack: one
  on-demand, AWS-managed-encrypted DynamoDB table (composite string `pk`/`sk`, `expiresAt`
  TTL, `RETAIN`). The Lambda's table grant is SEVEN actions — `Query`, `GetItem`,
  `BatchGetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `ConditionCheckItem` — and no Scan;
  what each serves is written beside the grant in `backend-stack.ts`. `ConditionCheckItem`
  is its own action (a transaction's standalone ConditionCheck, which #204's adoption uses):
  without it every erasing link is an AccessDeniedException, in production only. All seven
  are pinned by `backend-stack.test.ts`. Score rows persist while HMAC-IP dedup items
  expire after 48h. PITR is deliberately off because a backup would retain the pseudonymous
  dedup items past their privacy lifetime.
  **The EIGHT LIVE routes** — `scores*`, `profile*`, `board*`, `round*`, `groups*`,
  `history*`, `devices*`, `link*` — each have their own behavior of ONE shape
  (`liveBehavior`): AWS's managed zero-TTL `CachingDisabled` policy (the data is live and
  must never inherit the puzzle's year-long s-maxage), ALLOW_ALL methods (every one but
  `/scores` has a write or an authenticated POST, with the device token in the body;
  `/scores` is a read-only GET kept on the same shape, so a POST reaches its named 405), and an
  origin-request policy of ONE shape (`liveOriginRequestPolicy`): CloudFront's
  `allExcept: Host` header mode — the AWS Lambda-URL pattern, which carries the viewer's
  `x-amz-content-sha256` (mandatory for OAC to sign a Lambda-URL POST) and lets CloudFront
  set Host to the Function URL's own domain for that signature — no cookies, and a query
  allow-list naming EXACTLY what that route's handler reads: `/scores` and `/board`
  `lang`/`date`/`id`, `/profile` and `/groups` `id`, `/round` `lang`/`date`/`bonus`,
  `/history` `lang`/`month` (NOT `date`: a player's calendar is addressed by a MONTH, the
  sort-key prefix it is one Query over), `/devices` and `/link` none. An unlisted parameter
  never reaches the Lambda, so the day a handler reads a new one it is named there too (the
  root `AGENTS.md` table is the three-package contract). CloudFront rejects both a
  fully-zero custom cache policy with cache-key values and an origin allow-list that
  explicitly names a reserved `x-amz-*` header, so neither narrower-looking representation
  is deployable. **`allExcept` carries NO CloudFront-generated header**, so a
  `ScoreViewerIpFn` viewer-request FUNCTION — which first answers the route's CORS preflight,
  as `LivePreflightFn` alone does on `/profile`, `/board`, `/groups` and `/history` (root
  `AGENTS.md`, API routes; its headers are `@whippin/shared`'s `preflightHeaders`, and the
  test runs both functions' code against them) — stamps the connecting address into
  `@whippin/shared`'s `VIEWER_IP_HEADER` instead, on `/scores`, `/round` (its
  Turnstile-gated round creation, and the day's score row metered by its HMAC), `/devices`
  (the Turnstile-gated bootstrap) and `/link` (the Turnstile-gated, per-address-metered code
  send) — see the root `AGENTS.md` for why no single header mode can serve both halves.
  Removing that function ships a Lambda that throws on every gated write, which neither
  `backend:dev` nor a synthesized template can show; `backend-stack.test.ts` pins the
  associations and the stamp. `/devices` (#216) brings this table's **ONE secondary
  index**, `DeviceByAccount` (`gsi1pk`/`gsi1sk`, projecting the device row's label fields):
  authentication is a direct base-table read by the token's hash, so the index exists only
  for the sign-out screen's "which devices does this account have". DynamoDB projects the
  base primary key automatically; `/devices` returns its digest as the opaque revocation
  handle, so the subsequent delete addresses the base item directly and never depends on a
  second eventually-consistent query. The index needs no action of its own — `Table.grant`
  extends to `<table>/index/*` by itself once the table has an index — and
  `backend-stack.test.ts` pins the index's keys, its projection and the behavior's
  three-package allow-list. The Lambda
  receives the table name and SSM SecureString PARAMETER NAMES (defaults
  `/whippin/turnstile-secret`, `/whippin/ip-hmac-secret`; override with the matching `-c`
  contexts), reads both decrypted values together on first use, caches a successful result,
  retries a failed read on the next invocation, and has `ssm:GetParameters` only on those
  exact ARNs. No secret value appears in source or the synthesized template.
  Outputs: `ApiUrl` (→ `VITE_API_BASE_URL`), `PuzzleBucketName` (#4 upload target),
  `ScoreTableName`, `FunctionUrl`, `DistributionDomainName`, `DistributionId`. Commands: `pnpm infra:synth` / `infra:diff` /
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
  `https://<domain>` (override `-c allowedOrigin=`). `bin/app.ts` builds four sibling
  stacks — `WhippinBackendStack`, `WhippinWebStack` (below), `WhippinBotStack` and the
  human-deployed `WhippinDeployStack` — pass a stack name to target one. **All four are
  pinned to `us-east-1`**.
- **Web hosting stack (#21):** `lib/web-stack.ts` `WebStack` (`WhippinWebStack`) — a sibling
  of `BackendStack`, independently deployable (`cdk deploy WhippinWebStack`), **pinned to
  `us-east-1`** (CloudFront's ACM cert must live there). Hosts the built SPA
  (`packages/web/dist`) on a **private** S3 bucket (`DESTROY` + auto-delete; build is
  reproducible) served only via **CloudFront + OAC** over HTTPS. **Three path patterns are
  handed to the API origin instead of the bucket** — `/s/*` (the share page), `/og/*`
  (every card image) and `/g/*` (the #271 group invite link, which the backend renders so
  it unfurls as the group's name and its members' marks; its card sits under `/og/g/`).
  Adding a pattern here TAKES that path away from the SPA, which is exactly why the
  invite's landing is `/join/g/<groupId>` — see `shared/src/invite.ts` and the root
  `AGENTS.md`. **The SPA fallback is a viewer-request CloudFront Function
  (`SpaFallbackFn`) on the DEFAULT behavior alone**: a path whose last segment has no dot
  (`/`, `/en`, `/en/2026-09-01`, `/join/g/<id>`) is served `/index.html`; a file path
  (`/assets/x.js`, `/vocab/en.json`, `/version.json`) is left alone, so a missing file
  answers the bucket's own error, never the SPA shell. **A route the build gave a page of
  its own** (`<route>/index.html` — the web's link previews, `web/src/linkPreviews.ts`) is
  served that page instead, the NEAREST one at or above the path winning; the routes are read
  off the build at synth (`builtRoutePages`) and ride in the function's source, since a
  viewer-request function cannot ask the bucket what exists. A deploy without a build
  therefore publishes a function that knows no pages: the SPA is untouched, but the
  tutorial's routes unfurl as the home card until the next deploy with one. It is NOT a
  distribution-wide
  custom error response: that would also rewrite the three API behaviors' answers, serving
  a dead invite or share as 200 + the SPA shell and a dead card as HTML, where the backend
  answers a dead invite or share with a 404 page that moves a person on, and a dead card
  with a JSON 404. `web-stack.test.ts` runs the function's source against sample paths.
  Four `BucketDeployment`s split cache lifetimes (hashed `assets/*` immutable-1yr,
  `vocab/*` SWR, everything else `no-cache`) and **invalidate
  `/*`** on deploy — so `pnpm build` must run **before** deploy (missing `dist` → warn +
  skip upload). **The root set (index.html + version.json) publishes LAST** — an explicit
  `addDependency` on the chunks and the vocabulary, because `version.json` is the web's
  stale-tab reload trigger (`web/src/versionCheck.ts`) and index.html names the new hashed
  chunks: without the ordering, a tab reloading mid-deploy can fetch an index whose chunks
  are not in the bucket yet. **The route pages (`DeployPages`, `*/index.html`) publish after
  the chunks too, and BEFORE the fallback function** (the function `addDependency`s them):
  the function is updated as soon as the stack update starts, and naming a page the bucket
  does not hold yet would answer that route with the bucket's 403 until the upload landed.
  Custom
  domain comes from `-c domainName=<apex>` (**defaults to `whippin.ai`** in `bin/app.ts`): it
  looks up the existing Route53 zone (`fromLookup`), issues a DNS-validated **ACM** cert, sets
  the distribution alias to `<siteSubdomain>.<domain>` (`siteSubdomain` default **`""` = apex**;
  set e.g. `play`), and adds **A/AAAA** aliases. (The stack keeps a defensive no-domain
  branch — `*.cloudfront.net`, no ACM/Route53 — only for direct construction.) Wiring: build the web with
  `VITE_API_BASE_URL=https://api.<domain>` (the backend `ApiUrl`); the backend's CORS origin
  defaults to this site's `SiteUrl` (`https://<domain>`). Outputs: `SiteUrl`,
  `SiteBucketName`, `DistributionId`, `DistributionDomainName`.
- **Edge rate limits (WAF, `lib/rate-limits.ts`):** each distribution wears its own
  CLOUDFRONT web ACL of per-IP rate rules over five minutes, a blocked request answered 429
  with no body and no CORS headers (a transport failure to the clients). The API's: every
  request (3000). The web's: the render paths `/s/`, `/og/`, `/g/` alone (300) — it is the
  one that sees the VIEWER's address for them; the API distribution sees only the web
  distribution's edge servers, many viewers to an address, so a render limit there would
  block a region's cards at once. `web-stack.test.ts` pins that the web ACL limits exactly
  the paths handed to the API. With an operator address, `PuzzleFnThrottles`
  (`Throttles` ≥ 1 over 5 min, alarm AND recovery, missing data not breaching) and an
  account-wide monthly cost **budget** (`MONTHLY_BUDGET_USD`, actual > 100%) notify the
  `MailAlerts` topic, whose policy names `budgets.amazonaws.com` beside CloudWatch. No
  function traces to X-Ray.
- **The account purge worker (#207):** a second backend `NodejsFunction`, `PurgeFn`
  (`backend/src/purgeWorker.ts`, 512 MB, 5 min, reserved concurrency 1, `retryAttempts: 0` —
  the next hourly run is the retry), env `SCORE_TABLE` only, its own one-month log group, an
  EventBridge `rate(1 hour)` rule. It gets the API's exact DynamoDB action list
  (`ROW_STORE_ACTIONS`, ConditionCheckItem included, the index ARN with it) — no Scan, no
  BatchWriteItem, so a purge step that needs either has to widen the list and its test. With
  an operator address, a `PurgeFnErrors` alarm (`Errors` ≥ 1 over a day, missing data not
  breaching) notifies the `MailAlerts` topic. The privacy notice's "within 7 days" rests on
  this schedule.
- **Mail plumbing (#230):** `lib/mail.ts`, two constructs inside `BackendStack`, both gated on
  `-c operatorEmail=` (no default — a personal address in a public repo; CI passes the
  `OPERATOR_EMAIL` repository SECRET, masked in the public job log, and FAILS the backend
  deploy when it is unset). **`MailAlerts`** — an SNS
  topic (`enforceSSL`, deliberately NOT SSE: a CloudWatch alarm cannot publish through the
  AWS-managed `alias/aws/sns` key, so encryption with the free key would silently break the
  notification), a confirmed-by-hand email subscription, and `AWS/SES`
  `Reputation.BounceRate`/`ComplaintRate` alarms at AWS's own review rates (0.05 / 0.001),
  Maximum over an hour, missing data IGNORED (state held — `notBreaching` would mail a false
  recovery the moment a paused account stopped emitting). The topic policy NAMES
  `cloudwatch.amazonaws.com`, because `enforceSSL` replaces the default policy and would
  otherwise leave a lone Deny. **`MailReceiving`** — the apex `MX` at
  `inbound-smtp.<region>.amazonaws.com`, a private `DESTROY` landing bucket whose `inbound/`
  prefix expires after 30 days (the number the privacy notice states as "about" — S3 rounds
  expiry up to the next UTC midnight and deletes asynchronously), a receipt rule set for
  `hello@`/`abuse@`/`postmaster@`/`dmarc@` running **S3 then Lambda in that order** (the
  forwarder reads what the S3 action wrote), and a second `NodejsFunction` bundling
  `backend/src/mailForward.ts` with `ses:SendEmail` + `ses:SendRawEmail` on `identity/*`,
  conditioned on the one `ses:FromAddress` like the code sender's (a raw send is authorized
  as the raw action, and SES evaluates the statement against a recipient that is a verified
  identity, which the operator's address is).
  An `AwsCustomResource` ACTIVATES the rule set — SES holds one active rule set per region and
  exposes no CloudFormation property for it, so a deploy without it receives nothing — and the
  forwarder's failures alarm onto the same topic: its `Errors`, AND Lambda's
  `AsyncEventsDropped` (an async event that aged out while THROTTLED under the reserved
  concurrency of 5 is dropped, not errored), with the topic as the function's
  `onFailure` destination so the dropped event, which names the message, lands beside the
  alarm. `backend-stack.test.ts` pins the
  thresholds, the missing-data policies, the CloudWatch publish grant, the MX target, the
  four recipients, the action order, the activation, the retention, the dropped-event alarm
  and destination, and that NONE of it is built without an operator address. Output: `MailAlertsTopicArn`. Operator steps (README): confirm the SNS
  subscription, publish `rua=`, and SES sandbox exit.
