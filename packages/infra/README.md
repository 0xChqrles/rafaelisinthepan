# @rafaelisinthepan/infra

AWS **CDK** stack (issue #3) that provisions the daily-puzzle backend (#2) so it is
reproducible and deployable from one command:

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

```
              ┌──────────────┐    OAC (SigV4)   ┌───────────────────┐  s3:GetObject  ┌────────────┐
 viewer  ───▶ │  CloudFront  │ ───────────────▶ │ Lambda (Fn URL,   │ ─────────────▶ │ S3 (private│
  (HTTPS)     │  + cache     │                  │ IAM auth)         │                │  bucket)   │
              └──────────────┘                  └───────────────────┘                └────────────┘
```

## Commands

Run from this package (or the repo root via `pnpm infra:*`). The app command in
`cdk.json` runs the stack through `npx tsx bin/app.ts`, so no compile step is needed.

```bash
pnpm --filter @rafaelisinthepan/infra synth      # synthesize CloudFormation (also `pnpm infra:synth` from root)
pnpm --filter @rafaelisinthepan/infra diff       # diff against the deployed stack   (`pnpm infra:diff`)
pnpm --filter @rafaelisinthepan/infra deploy      # deploy                            (`pnpm infra:deploy`)
pnpm --filter @rafaelisinthepan/infra destroy     # tear down (the bucket is RETAINed)
pnpm --filter @rafaelisinthepan/infra typecheck   # tsc --noEmit
```

Deploying needs AWS credentials in the environment and a **bootstrapped** account/region
(`npx cdk bootstrap` once per account+region). Set the real web origin for CORS at deploy
time:

```bash
pnpm --filter @rafaelisinthepan/infra deploy -c allowedOrigin=https://your-web-origin
```

## Outputs

`cdk deploy` prints:

| output             | use                                                                 |
| ------------------ | ------------------------------------------------------------------- |
| `ApiUrl`           | CloudFront URL the web app calls — set as `VITE_API_BASE_URL`.      |
| `PuzzleBucketName` | the S3 bucket to publish puzzles into (`pnpm puzzle:publish --s3`). |
| `FunctionUrl`      | the Lambda Function URL (CloudFront origin; not called directly).   |

## Notes

- The bucket uses `RemovalPolicy.RETAIN` — `destroy` leaves it (and its puzzles) in
  place so a teardown never drops history; delete it manually if you really mean to.
- Bundling uses local **esbuild** (an esbuild dev dependency here); no Docker required.
- `@aws-sdk/*` is left external — the Node 22 Lambda runtime already provides AWS SDK v3.
