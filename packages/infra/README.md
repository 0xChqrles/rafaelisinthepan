# @whippin/infra

AWS **CDK** app with three independent sibling stacks, each deployable on its own
(`cdk deploy <StackName>`):

- **`WhippinBackendStack`** (issue #3) — the daily-puzzle backend (#2).
- **`WhippinWebStack`** (issue #21) — hosting for the web front (`packages/web`).
- **`WhippinDeployStack`** (issue #33) — CI auth: the GitHub OIDC provider + the IAM role
  the Deploy workflow assumes. Deployed once by a human, not by CI (see below).

All three stacks are **pinned to `us-east-1`** (CloudFront's ACM certs must live there, so the
certs stay in-stack with no cross-region reference). A single `-c domainName=<apex>` wires
the custom domains: the **site** serves at the apex (`https://<domain>`) and the **API** at
`https://api.<domain>` (a stable `VITE_API_BASE_URL`), with the backend's CORS origin
defaulting to the site origin. The hosted zone (`<domain>`) must already exist in Route53.

## `WhippinBackendStack` (#3) — daily-puzzle backend

Provisions the backend (#2) so it is reproducible and deployable from one command:

- **S3 puzzle bucket** — private (all public access blocked, TLS enforced, encrypted).
  Holds `<YYYY-MM-DD>.<lang>.json` objects keyed by
  [`backend/src/layout.ts`](../backend/src/layout.ts). Upload target for #4.
- **DynamoDB score table** — on-demand, encrypted, retained on teardown, composite
  `pk`/`sk` key (#187). One first-write-wins score row per `(date, lang, mode, publicId)`
  is permanent — a daily's partition is read back whole by one Query — while HMAC-IP
  dedup items have an `expiresAt` TTL and disappear after 48 hours. PITR is intentionally
  disabled so backups cannot extend the pseudonymous dedup data's lifetime. There are no
  indexes or scans.
- **Lambda + Function URL** — runs the existing backend entrypoint
  [`backend/src/index.ts`](../backend/src/index.ts) (`createHandler` over the S3 store),
  bundled with esbuild at synth time. Reads `PUZZLE_BUCKET` / `ALLOWED_ORIGIN` from the
  environment (set by the stack), plus score table/secret configuration. Granted
  **read-only** S3, only DynamoDB `Query`/`PutItem`/`UpdateItem`, and SSM `GetParameters`
  on the two exact SecureString ARNs; the Function URL is
  **IAM-auth** so only CloudFront can invoke it.
- **CloudFront** — CDN in front of the Function URL via **Origin Access Control**. Cache
  key = request path + the `lang`, `date` and `mode` query strings (the allowList in
  `lib/backend-stack.ts` — with no origin request policy on that behavior, an unlisted
  parameter never reaches the Lambda at all); the origin's `Cache-Control`
  (`max-age=300, s-maxage=31536000`) drives the TTL, purged by
  `pnpm puzzle:publish --s3` and by the backend deploy job.
  `/scores` is a separate zero-TTL behavior: it allows POST, uses AWS's managed
  `CachingDisabled` policy, and forwards exactly `lang`, `date`, `mode` through its origin
  request policy outside the unused cache key. That policy uses CloudFront's Lambda-URL-safe
  `allExcept: Host` header mode, which carries the viewer-supplied `x-amz-content-sha256`
  (required for OAC to sign a Lambda-URL POST; explicitly allowlisting the reserved `x-amz-*`
  header is rejected by CloudFront). That mode forwards viewer headers ONLY, so it cannot
  deliver a CloudFront-GENERATED header — a viewer-request **CloudFront Function** stamps the
  connecting address into `VIEWER_IP_HEADER` instead, which is what feeds the server-side
  HMAC dedup. This behavior cannot inherit the puzzle response's year-long cache.
- **Custom API domain (optional)** — with `-c domainName=<apex>` the distribution serves at
  `api.<domain>` (override the label with `-c apiSubdomain=`): a DNS-validated ACM cert
  in-stack (this stack is in `us-east-1`) plus Route53 A/AAAA aliases. Without it the API
  stays on its `*.cloudfront.net` domain. `ApiUrl` is the value to use for
  `VITE_API_BASE_URL`.

```
              ┌──────────────┐    OAC (SigV4)   ┌───────────────────┐  s3:GetObject  ┌────────────┐
 viewer  ───▶ │  CloudFront  │ ───────────────▶ │ Lambda (Fn URL,   │ ─────────────▶ │ S3 puzzles │
  (HTTPS)     │ cache split  │                  │ IAM auth)         │ ───────┐        └────────────┘
              └──────────────┘                  └───────────────────┘        │ Get/Update
                                                                            ▼
                                                                      ┌────────────┐
                                                                      │ DynamoDB   │
                                                                      │ scores     │
                                                                      └────────────┘
```

### Score secrets

The stack puts only two existing **SSM SecureString parameter names** in the Lambda
environment. On first use, the entrypoint resolves both values with one decrypted
`GetParameters` call and reuses a successful result for that execution environment. A
failed read is discarded so the next invocation retries. Their values never appear in
source, Lambda configuration, or `cdk synth` output.
Create them once before the first score-enabled deploy:

```bash
aws ssm put-parameter --region us-east-1 --type SecureString \
  --name /whippin/turnstile-secret --value '<Cloudflare Turnstile secret>'
aws ssm put-parameter --region us-east-1 --type SecureString \
  --name /whippin/ip-hmac-secret --value "$(openssl rand -hex 32)"
```

Use `--overwrite` for an intentional rotation. Alternate parameter names can be supplied
with `-c turnstileSecretParameter=/path -c ipHmacSecretParameter=/path`.

### Mail: sending, bouncing, and receiving (#204/#230)

The stack verifies the **domain identity** the account codes are sent from (EasyDKIM, its three
CNAMEs published into the same hosted zone) and, with `-c operatorEmail=<address>`, everything
that handles what comes **back**:

- **SES reputation alarms** on `Reputation.BounceRate` (> 5%) and `Reputation.ComplaintRate`
  (> 0.1%) — the rates AWS reviews an account at, and can pause its sending over; missing data
  holds the alarm's state, so a paused (silent) account never reads as recovered — plus two
  alarms on the forwarder (its `Errors`, and Lambda's `AsyncEventsDropped` for an invocation
  it gave up on while throttled), all onto one SNS topic (`MailAlertsTopicArn`). A dropped
  invocation's event is also delivered to that topic, so the notification names the message.
- **Inbound mail**: an apex `MX` at `inbound-smtp.us-east-1.amazonaws.com`, a receipt rule set
  for `hello@`, `abuse@`, `postmaster@` and `dmarc@`, a private landing bucket (objects expire
  after about 30 days — S3 rounds expiry up to the next UTC midnight and deletes asynchronously)
  and a Lambda that forwards each message to `operatorEmail`.

`operatorEmail` has **no default** — it is a personal address and this repo is public. CI passes
the `OPERATOR_EMAIL` repository variable and **fails the backend deploy when it is unset**: a
local synth may want the stack without it, production never does. Without it the stack builds
**none** of the above: an alarm nobody is subscribed to and an MX nobody reads are the failure
this plumbing removes, not lesser versions of it.

#### Operator steps (none of these can be automated)

1. **Confirm the SNS subscription.** The first deploy emails a confirmation link to
   `operatorEmail`. Until someone clicks it, **no alarm notification is delivered** — the
   subscription, not the alarm, is what makes this worth having.

   ```bash
   aws sns list-subscriptions-by-topic --region us-east-1 \
     --topic-arn "$(aws cloudformation describe-stacks --region us-east-1 \
       --stack-name WhippinBackendStack \
       --query "Stacks[0].Outputs[?OutputKey=='MailAlertsTopicArn'].OutputValue" --output text)"
   # A SubscriptionArn of "PendingConfirmation" means the link is still unclicked.
   ```

2. **Request SES production access** (sandbox exit). Per **region** — the backend stack is
   `us-east-1`, so ask there, not in whatever region the CLI defaults to. Until AWS lifts it,
   codes only reach addresses verified as identities, so a fresh deployment sends into a void
   for every address but the operator's own.

3. **Publish the DMARC `rua=`.** Now that `dmarc@<domain>` receives, aggregate reports have
   somewhere to land — which is how you learn your mail is being rejected somewhere, and the
   prerequisite for ever tightening `p=none` to `quarantine`/`reject`. Pointing `rua` at an
   off-domain mailbox does not work: the receiving domain has to publish a
   `<domain>._report._dmarc.<their-domain>` authorization record, which we cannot create.

   ```
   _dmarc.<domain>  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@<domain>"
   ```

**SPF and DMARC stay by hand** — they state the zone's mail policy for *every* sender of the
domain, which is not something this stack may silently overwrite. (The `MX` **is** in the stack:
it names the receiver these very resources provision, and a receipt rule set with no MX in front
of it receives nothing.) Two foot-guns with those by-hand records:

- SPF is `v=spf1 include:amazonses.com -all`. The `-all` is a **hard** fail, so any other
  outbound sender for this domain must have its `include:` added **in the same change**, or its
  mail hard-fails everywhere.
- That SPF string is the apex TXT RRSet's only value, and **Route53 replaces an RRSet
  wholesale**. Any later apex TXT (a provider's domain-verification string, say) must be
  UPSERTed carrying **both** values, or it silently deletes SPF.

Locally there is no SES at all: `pnpm backend:dev` **prints** the code to its own log.

## `WhippinBotStack` (#236) — the WhatsApp group bot

One Fargate task holding the one Baileys (WhatsApp Web) session, a bot-owned DynamoDB table,
an SQS outbound queue, a podium Lambda scheduled per configured group, and alarms. Independent
of the two app stacks. Deployed by `deploy.yml` (`deploy-bot`) like the others; the image is
built from the repo root by the runner's Docker.

### Operator steps (by hand)

1. **The model key.** Create the SSM SecureString the task and the Lambda read at runtime:
   ```bash
   aws ssm put-parameter --name /whippin/bot/llm-api-key --type SecureString --value '<DeepSeek key>'
   ```
   Another name: `-c botLlmApiKeyParameter=…`. Provider/model: `-c botLlmProvider=` /
   `-c botLlmModel=` (defaults `deepseek` / `deepseek-v4-flash`). No key = no comments and no
   chat; the scoreboard still runs.
2. **Confirm the alerts subscription** (`AlertsTopicArn`, the `OPERATOR_EMAIL` address) —
   nothing is delivered until the email is confirmed.
3. **Pair the dedicated number.** The task must NOT hold the session: scale the service to 0,
   pair from a laptop with AWS credentials against the deployed table, scale back to 1.
   ```bash
   aws ecs update-service --cluster <ClusterName> --service <ServiceName> --desired-count 0
   BOT_TABLE=<BotTableName> pnpm bot:pair                 # QR; or --phone 33612345678 for a code
   BOT_TABLE=<BotTableName> pnpm bot:cli groups           # the group JIDs, for step 4
   aws ecs update-service --cluster <ClusterName> --service <ServiceName> --desired-count 1
   ```
   A device WhatsApp logged out is never re-paired automatically: the task idles, the
   `Disconnected` alarm fires, and `pnpm bot:pair --reset` is the way back.
4. **Configure the test group.** Group configs are NOT committed — a group JID names a real
   private conversation and this repo is public — so SSM holds them, one `String` parameter
   per group at `/whippin/bot/groups/<slug>`:
   ```bash
   pnpm bot:groups edit test     # $EDITOR on example.json; paste the JID, set enabled: true
   pnpm bot:groups list          # what SSM now holds, and the region it read
   ```
   SSM is regional and the wrong region answers an EMPTY LIST rather than an error, so the
   CLI PINS the region to `us-east-1` (where every stack is pinned) instead of inheriting
   the shell's, and prints it with every answer. **Every AWS client the bot builds is pinned
   the same way** (`botRegion()`, `whatsapp-bot/src/config/env.ts`) — `pnpm bot:pair` and
   `pnpm bot:cli` included, where a laptop on another region met
   `ResourceNotFoundException: Requested resource not found`, which is true and points
   nowhere near the cause. `BOT_AWS_REGION` overrides it if a deployment ever moves.
   The CLI takes no session lease, so it runs with the bot connected. **Editing SSM does not
   change production**: `deploy-bot` runs `pnpm bot:groups pull` into the gitignored
   `groups/local/` snapshot and builds the image, the Lambda bundle and the podium SCHEDULES
   from it, so a deploy is what promotes the change. Deploying by hand means pulling first.
   The production group is a later config change, after the test group has exercised
   reconnect, ingestion, dedup and outbound delivery.

   This needs `ssm:GetParametersByPath` on that path for the CI deploy role, which lives in
   the human-deployed `WhippinDeployStack`: run `pnpm --filter @whippin/infra deploy:auth`
   once, or `deploy-bot`'s pull step fails with `AccessDenied`.
5. **Replay a podium by hand** if needed: invoke `PodiumFunctionName` with
   `{"group": "<jid>", "date": "YYYY-MM-DD"}` (the command id dedups a day already posted).

**`WhippinBotStack` outputs**

| output | use |
| --- | --- |
| `BotTableName` | `BOT_TABLE` for `pnpm bot:pair` / `pnpm bot:cli`. |
| `OutboundQueueUrl` | the outbound command queue the task consumes. |
| `ClusterName`, `ServiceName` | scale to 0 before pairing, back to 1 after. |
| `PodiumFunctionName` | manual podium replay. |
| `AlertsTopicArn` | the SNS topic behind the disconnected / dead-letter / podium-error alarms — **confirm its email subscription by hand**. |
| `ConfiguredGroups` | what the deployed config enables, at a glance. |

## `WhippinWebStack` (#21) — web front hosting

Hosts the built SPA (`packages/web/dist`) on a **private S3 bucket** served only through
**CloudFront** (Origin Access Control) over HTTPS, with **SPA fallback** (403/404 →
`/index.html`, 200). With a custom domain it adds a **DNS-validated ACM certificate** and
**Route53** A/AAAA aliases. The stack is **pinned to `us-east-1`** — the region CloudFront
requires for its ACM cert — so the cert lives in-stack with no cross-region reference.

- **S3 SPA bucket** — private (all public access blocked, TLS enforced, encrypted),
  `RemovalPolicy.DESTROY` + auto-delete: it holds only the current build (fully
  reproducible), so teardown is clean.
- **CloudFront** — HTTPS (`REDIRECT_TO_HTTPS`), `CACHING_OPTIMIZED`, SPA fallback. The
  build is uploaded by three `BucketDeployment`s: hashed `assets/*` get
  `Cache-Control: public, max-age=31536000, immutable`, `vocab/*` its own
  stale-while-revalidate policy, and everything else (`index.html`, fonts) `no-cache`.
  The last one **invalidates `/*`**.
- **Custom domain (optional)** — pass `-c domainName=<apex>` (the Route53 hosted zone must
  already exist in the account). The site serves at the **apex** (`<domain>`) by default;
  pass `-c siteSubdomain=play` for `play.<domain>`. Without `domainName` the stack still
  synthesizes/deploys on the default `*.cloudfront.net` domain (no ACM/Route53) — handy for
  a credential-free smoke synth.

> **Build before deploy.** `cdk deploy WhippinWebStack` zips `packages/web/dist` at synth
> time, so run `pnpm build` first (with `VITE_API_BASE_URL` and
> `VITE_TURNSTILE_SITE_KEY` set, see *Wiring* below). If
> `dist` is absent the stack still deploys but **skips the upload** with a warning.

## `WhippinDeployStack` (#33) — CI auth bootstrap

Provisions GitHub Actions' authentication to AWS as code, so there is **no console
clicking** for the `AWS_DEPLOY_ROLE_ARN` the [Deploy workflow](../../.github/workflows/deploy.yml)
uses:

- **GitHub OIDC provider** — `token.actions.githubusercontent.com`, audience
  `sts.amazonaws.com`. It is **account-global** (one per URL), so by default the stack
  **imports** the account's existing provider (deriving its ARN from the account id, no
  hardcoding). On a brand-new account that has none yet, pass `-c createOidcProvider=true`
  on the first deploy to create it. (`-c githubOidcProviderArn=<arn>` imports a specific
  one if you ever need to.)
- **Prod deploy role** (`whippin-github-deploy`) — trusted **only** by this repo's Actions
  and **only** for pushes on `main` (subject
  `repo:<owner>/<repo>:ref:refs/heads/main`). Its permissions are minimal: `sts:AssumeRole`
  on the `cdk-hnb659fds-*` bootstrap roles + `cloudformation:DescribeStacks` — modern CDK
  performs every real change through the assumed bootstrap roles, so this role can't touch
  infrastructure on its own. Its ARN is the `DeployRoleArn` output → the repo secret.
- **Preview role (optional)** — `-c enablePreviewRole=true` adds `whippin-github-preview`,
  trusted for `pull_request` runs, for a future PR-preview pipeline.

```bash
# One-time, with YOUR AWS credentials (account must be `cdk bootstrap`-ed in us-east-1):
pnpm --filter @whippin/infra deploy:auth
# Copy the printed DeployRoleArn into the GitHub repo secret AWS_DEPLOY_ROLE_ARN.

# Point it at a different repo / branch (the account's OIDC provider is imported by
# default; add -c createOidcProvider=true only on an account that doesn't have one yet):
pnpm --filter @whippin/infra deploy:auth \
  -c githubOwner=me -c githubRepo=myrepo -c deployBranch=main
```

> **Why a human deploys this, not CI.** The deploy role deliberately **cannot create or
> edit IAM** — so a compromised pipeline can't widen its own privileges. That means CI
> can't deploy `WhippinDeployStack` itself; deploy it (and any change to it) with account
> credentials. `deploy.yml` only ever targets the backend/web stacks.
>
> **On PR previews & security.** Fork PRs never receive an OIDC token, and same-repo PR
> runs carry the `:pull_request` subject — which the **prod** role does not trust — so PR
> code can never assume the prod role or deploy to `main`. Enabling the preview role is
> step one of safe previews, not the whole story: because it can still assume the same
> `cdk-hnb659fds-*` bootstrap roles, a real isolation boundary also needs a lower-privilege
> target (a separate stack, and ideally a scoped bootstrap qualifier / permissions
> boundary). Add that when the preview pipeline actually lands.

### Wiring the two app stacks

The stable custom domains break the chicken-and-egg: both URLs are known up front from
`domainName`, so there is no back-and-forth. The site is `https://<domain>`, the API is
`https://api.<domain>`, and the backend's CORS `allowedOrigin` **defaults to the site
origin** (override with `-c allowedOrigin=`).

```bash
# 1. Backend → api.<domain> (CORS defaults to https://<domain>).
pnpm --filter @whippin/infra run deploy WhippinBackendStack -c domainName=whippin.ai
# 2. Build the web. `VITE_API_BASE_URL` comes from the committed .env.production;
#    supply the public Turnstile site key (CI reads it from the required repo variable).
VITE_TURNSTILE_SITE_KEY='<site-key>' pnpm build
# 3. Deploy the site at the apex (uploads dist, invalidates CloudFront).
pnpm --filter @whippin/infra run deploy WhippinWebStack -c domainName=whippin.ai
```

The ACM certs are DNS-validated against the `whippin.ai` hosted zone, so the first deploy of
each stack waits for the `CNAME` validation records it creates (a few minutes).

## Commands

Run from this package (or the repo root via `pnpm infra:*`). The app command in
`cdk.json` runs the app through `npx tsx bin/app.ts`, so no compile step is needed. Pass a
**stack name** to target one (omit it to act on all three):

```bash
pnpm --filter @whippin/infra synth      # synthesize CloudFormation (also `pnpm infra:synth` from root)
pnpm --filter @whippin/infra diff       # diff against the deployed stack(s) (`pnpm infra:diff`)
pnpm --filter @whippin/infra run deploy      # deploy                            (`pnpm infra:deploy`)
pnpm --filter @whippin/infra destroy     # tear down (the puzzle bucket is RETAINed)
pnpm --filter @whippin/infra typecheck   # tsc --noEmit

# Target a single stack (args pass straight through to cdk):
pnpm --filter @whippin/infra run deploy WhippinBackendStack -c domainName=whippin.ai
pnpm --filter @whippin/infra run deploy WhippinWebStack     -c domainName=whippin.ai
pnpm --filter @whippin/infra run deploy WhippinBotStack     -c operatorEmail=you@example.com
```

Deploying needs AWS credentials in the environment and a **bootstrapped** account/region
(`npx cdk bootstrap` once for `us-east-1`). With `-c domainName`, both stacks resolve the
domain's **Route53 hosted zone** (which must already exist) via `HostedZone.fromLookup`,
caching the result into `cdk.context.json`.

## Outputs

`cdk deploy` prints, per stack:

**`WhippinBackendStack`**

| output                   | use                                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| `ApiUrl`                 | API base URL the web app calls — `https://api.<domain>` — set as `VITE_API_BASE_URL`. |
| `PuzzleBucketName`       | the S3 bucket to publish puzzles into (`pnpm puzzle:publish --s3`).        |
| `ScoreTableName`         | the DynamoDB table holding per-player score rows + 48h dedup items.        |
| `FunctionUrl`            | the Lambda Function URL (CloudFront origin; not called directly).         |
| `DistributionDomainName` | the CloudFront default domain (Route53 alias target for `api.<domain>`).   |
| `DistributionId`         | the distribution the deploy job and `puzzle:publish --s3` invalidate.      |
| `MailAlertsTopicArn`     | the SNS topic behind the SES bounce/complaint alarms — **confirm its email subscription by hand**. Only with `-c operatorEmail=`. |

**`WhippinWebStack`**

| output                   | use                                                          |
| ------------------------ | ------------------------------------------------------------ |
| `SiteUrl`                | the live site URL — set the backend `allowedOrigin` to it.   |
| `SiteBucketName`         | the S3 bucket holding the built SPA.                         |
| `DistributionId`         | the CloudFront distribution id (manual invalidations).       |
| `DistributionDomainName` | the CloudFront default domain (Route53 alias target).        |

## Migrating the backend to `us-east-1`

The backend was originally deployed to `eu-west-1`; both stacks are now pinned to
`us-east-1` (so `api.<domain>`'s ACM cert lives in-stack). **Tear the old stack down
FIRST** — CloudFront **cache policies and OACs are account-global**, so an old `eu-west-1`
stack and a new `us-east-1` stack collide on the same global names (`409 AlreadyExists`)
if both exist at once.

The old stack can't be removed with `cdk destroy` (the CDK code now pins this stack to
`us-east-1`, so `cdk destroy WhippinBackendStack` targets us-east-1 regardless of
`AWS_REGION`). Delete it via CloudFormation directly:

```bash
# 1. Delete the old eu-west-1 stack and WAIT for it to finish (CloudFront distribution
#    deletion is slow, ~15–20 min). Its RETAINed puzzle bucket is left behind.
aws cloudformation delete-stack       --stack-name WhippinBackendStack --region eu-west-1
aws cloudformation wait stack-delete-complete --stack-name WhippinBackendStack --region eu-west-1
# 2. If a previous us-east-1 attempt left WhippinBackendStack in ROLLBACK_COMPLETE, drop it
#    (a ROLLBACK_COMPLETE stack can't be updated):
aws cloudformation delete-stack       --stack-name WhippinBackendStack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name WhippinBackendStack --region us-east-1
# 3. Now deploy fresh in us-east-1 (global names are free).
pnpm --filter @whippin/infra run deploy --all -c domainName=whippin.ai
```

The old `eu-west-1` puzzle bucket is `RETAIN`ed, so step 1 leaves it behind — delete it
manually (`aws s3 rb s3://<old-bucket> --force --region eu-west-1`) once you have confirmed
nothing of value remains. Re-publish puzzles to the new bucket with `pnpm puzzle:publish --s3`.

## Notes

- The **inbound mail** bucket (#230) uses `DESTROY` with auto-delete, and expires its objects
  after 30 days: it holds other people's mail, so a teardown that orphaned it would leave
  correspondence in an account nothing manages any more.
- The **puzzle** bucket uses `RemovalPolicy.RETAIN` — `destroy` leaves it (and its puzzles)
  in place so a teardown never drops history; delete it manually if you really mean to. The
  **SPA** bucket uses `DESTROY` (the build is reproducible), so it is removed on teardown.
- Bundling uses local **esbuild** (an esbuild dev dependency here); no Docker required.
- `@aws-sdk/*` is left external — the Node 22 Lambda runtime already provides AWS SDK v3.
