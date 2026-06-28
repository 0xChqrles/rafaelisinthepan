# @rafaelisinthepan/backend

AWS Lambda (Function URL) that serves the **daily puzzle** and is the **authoritative
time source**. Fronted by CloudFront in prod; reads puzzles from S3. (The CDK stack
that provisions Lambda + Function URL + CloudFront + the bucket is issue #3.)

## Endpoints

- `GET /?lang=<xx>` (or `GET /puzzle?lang=<xx>`) → the active day's puzzle JSON for
  `lang`, in the front's [`Puzzle`](../shared/src/types.ts) shape. `404` (clean JSON
  error) if there's no puzzle for that day/lang.
- `GET /today` → `{ date, dayNumber, timeZone, resetHour, nextResetAt,
  secondsUntilNextReset }` — the server's current game day and the next flip.
- `OPTIONS *` → CORS preflight (`204`).

## The day boundary

The active puzzle day flips at **22:00 America/New_York** (NYT-style: a date's puzzle
goes live the evening before). Conversions are **DST-correct** — the NY wall clock is
read via `Intl` with the IANA zone, never a fixed UTC offset. See `src/day.ts`.

`Cache-Control` on a puzzle hit is set to expire exactly at the next 22:00 ET flip, so
CloudFront serves it cache-hot all day and revalidates at the boundary.

## S3 layout

```
s3://<bucket>/<YYYY-MM-DD>.<lang>.json
```

The key is fully determined by (game day, lang), so the Lambda `GetObject`s the one
object directly — no `ListObjects` scan — and a flat key stays listable by a date
prefix (`2026-06` for a month, `2026` for a year). The puzzle's words live in the file,
not the key. The publish step (issue #4) maps the generator's
`word/<lang>/<s1>_<s2>_<s3>.json` output onto this key. The encoding is shared with the
local store in `src/layout.ts` (`storeKey`), so local FS and S3 cannot drift apart.

## Environment

| var             | required | meaning                                          |
| --------------- | -------- | ------------------------------------------------ |
| `PUZZLE_BUCKET` | yes      | S3 bucket holding the daily puzzles              |
| `ALLOWED_ORIGIN`| no       | CORS origin (the web origin in prod; `*` if unset) |

## Local harness (no AWS) — issue #17

Run the **same `createHandler`** locally, swapping the S3 store for a filesystem store
(`src/fsStore.ts`). The day boundary, 404-no-puzzle, CORS, and `Puzzle` shape are
therefore identical to production — `src/serve.ts` is just a Function-URL ⇄ HTTP adapter.

```bash
# 1. Generate a puzzle (writes packages/web/public/word/<lang>/<s1>_<s2>_<s3>.json)
pnpm gen:phrase "<sentence>" --lang fr --words a b c

# 2. Publish it into the local store for a chosen day (defaults to local + the active day)
pnpm puzzle:publish packages/web/public/word/fr/a_b_c.json            # local, today
pnpm puzzle:publish packages/web/public/word/fr/a_b_c.json --day 2026-07-01
pnpm puzzle:publish packages/web/public/word/fr/a_b_c.json --s3 --bucket my-bucket  # real S3

# 3. Serve it (GET /?lang=<xx>, GET /today) with no AWS creds
pnpm backend:dev          # http://localhost:8787

# 4. Point the front at it and play end-to-end (no ?puzzle= needed)
#    packages/web/.env(.local):  VITE_API_BASE_URL=http://localhost:8787
pnpm dev
```

### Local store layout

Mirrors S3 one-to-one (the prefix is a dir instead of a bucket); encoded once in
`src/layout.ts` (`storeKey`) and shared by the reader (`fsStore`) and writer (`publish`):

```
<store-root>/<YYYY-MM-DD>.<lang>.json
```

`<YYYY-MM-DD>` is the **game day** (the 22:00-ET day, not the generation day); `<lang>`
is the language. The key is flat and fully determined by (date, lang) — read directly,
no listing — and listable by a date prefix. The store root defaults to
`packages/backend/.local-store` (gitignored); override with `PUZZLE_STORE`.

| var            | default                 | meaning                                   |
| -------------- | ----------------------- | ----------------------------------------- |
| `PORT`         | `8787`                  | local server port (`serve:local`)         |
| `PUZZLE_STORE` | `.local-store`          | local store root read by `fsStore`        |
| `ALLOWED_ORIGIN`| `*`                    | CORS origin                               |

## Dev

```bash
pnpm --filter @rafaelisinthepan/backend test       # vitest (day boundary + handler + store/layout)
pnpm --filter @rafaelisinthepan/backend typecheck  # tsc --noEmit
```
