# AGENTS.md — @whippin/backend (daily-puzzle backend)

> Package-scoped guidance. The root `AGENTS.md` applies here too and holds the
> contracts this server implements — the per-puzzle JSON schema it serves and the
> day-addressed routing protocol (date rules, future-skew guard, 404 semantics, CDN
> caching) — plus the testing policy and the issue/PR workflow. Read it first.
> The share routes (`/s/<token>`, `/og/<token>.png`) render tokens from the shared
> `shareCard` codec; their product behavior is described in the solved-result bullet
> of `packages/web/AGENTS.md`.

## File map

```
  backend/                    daily-puzzle backend (pkg @whippin/backend, #2)
    src/
      handler.ts              createHandler() — the ONE day/404/CORS/Puzzle logic (Lambda + local)
      store.ts                PuzzleStore interface (date+lang -> Puzzle | null)
      s3Store.ts, fsStore.ts  store impls: S3 (prod) and local FS (#17), both read the same key
      layout.ts               storeKey() — the <date>.<lang>.json key shared by readers + publish (#17/#4)
      serve.ts                local HTTP server: Function-URL⇄HTTP adapter over createHandler (#17)
      publish.ts              place a generated puzzle into local store (default) or S3 (#17/#4)
      index.ts                Lambda entrypoint (s3Store + env config)
    .local-store/<date>.<lang>.json  local puzzle store (gitignored) read by serve/fsStore
```

---

## Commands

```bash
# Local backend harness (@whippin/backend, #17) — no AWS creds needed.
pnpm puzzle:publish <puzzle.json> [--day YYYY-MM-DD] [--s3]  # default: local + active day; --s3 -> the deployed bucket (stack output)
pnpm puzzle:inventory [--s3] [--days N] [--langs en,fr] [--ci]  # publish-buffer coverage (#61); reports + exits 0 by default, --ci exits 1 on any (day,lang) gap for cron/CI
pnpm backend:dev                # local server (GET /?lang=, /today) on :8787 over the local store
```

---

## Current state / mutable

*(Safe to update without touching the invariants above.)*

- **Puzzle responses are content-negotiated AT THE ORIGIN (#123/#124, decided
  2026-07-26).** A puzzle is megabytes of rank maps (#104's alias expansion roughly tripled
  them), and Lambda refuses a response **envelope** over ~6.29 MB with a 413 the caller only
  ever sees as a bare 502 — the size to check is the envelope, not the body, because the body
  is escaped into it (every `"` costs a second byte, ~18% on quote-dense JSON). So
  `respond.ts` `jsonCompressed()` compresses the puzzle with the best coding the client
  accepts — **brotli preferred, gzip fallback**, `q=0` honoured, a refusal outranking a `*`
  wildcard (RFC 9110 §12.5.3), 1 KB floor. **Brotli is not optional politeness:** CloudFront
  normalizes `Accept-Encoding` down to the br/gzip the viewer offered *and forwards it to the
  origin*, so `br` can arrive alone; it also prefers brotli for viewers that offer it and
  passes an already-encoded origin response straight through, so a gzip-only origin would
  hand browsers MORE bytes than the CDN's own compression did. Two rules for anyone editing
  this: **`Vary` must be APPENDED, not overwritten** (the CORS `Vary: Origin` has to survive
  alongside `Accept-Encoding`), and the handler owns an **envelope-size guard** that answers
  a still-too-large payload with a named `payload_too_large` 500 **and `console.error`s it** —
  the log line is not decoration, it is the only thing that reaches CloudWatch, because a
  handler that RETURNS an error status is a SUCCESSFUL invocation (Errors metric 0, clean log
  group). The guard budgets ~8 KB below the cap since it models the runtime payload rather
  than measuring it.
- **Local backend harness (#17):** `pnpm backend:dev` runs the **same `createHandler`**
  as the deployed Lambda over a local filesystem store (`fsStore`), so the day/404/CORS/
  `Puzzle` behaviour is identical to prod with no AWS creds. `pnpm puzzle:publish
  <file>` places a generated puzzle into the store — **local by default**, `--s3`
  to push real S3, `--day YYYY-MM-DD` to target a game day (defaults to the
  active 22:00-ET day). `--s3` always targets the ONE bucket the infra package deploys —
  `publish` reads its name (and the API `DistributionId`) from the outputs of
  `WhippinBackendStack` (us-east-1) via CloudFormation `DescribeStacks` (#4), so the infra
  code is the single source of truth and there is **no bucket flag/env**. After the upload
  it **invalidates `/*` on the API distribution** (the date-addressed puzzle URL is
  CDN-cached long, so a republish must purge it; needs `cloudformation:DescribeStacks` +
  `cloudfront:CreateInvalidation`
  + the SDKs `@aws-sdk/client-cloudformation`/`client-cloudfront`; the bucket is addressed in us-east-1 where the
  stack is pinned). Store key (shared by readers + writer in `backend/src/layout.ts`,
  identical for local FS and S3): flat `<root>/<date>.<lang>.json` — fully determined by
  (date, lang), so the stores GetObject/readFile it directly (no list+filter) and it
  stays listable by a date prefix; root defaults to `backend/.local-store` (gitignored),
  override via `PUZZLE_STORE`. Point `VITE_API_BASE_URL=http://localhost:8787` and
  `pnpm dev` plays end-to-end (including 404 → NO PUZZLE). Runs TS via `tsx`
  (backend devDep).
