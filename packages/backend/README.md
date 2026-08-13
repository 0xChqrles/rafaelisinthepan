# @whippin/backend

AWS Lambda (Function URL) that serves the **daily puzzle**. Fronted by CloudFront in
prod; reads puzzles from S3. (The CDK stack
that provisions Lambda + Function URL + CloudFront + the bucket is issue #3.)

## Endpoints

- `GET /?lang=<xx>&date=<YYYY-MM-DD>[&mode=word]` → that day's sentence puzzle, or Word
  mode's single-word artifact under `mode=word`, in the front's
  [`Puzzle`](../shared/src/types.ts) / [`WordPuzzle`](../shared/src/types.ts) shape.
  `404` (clean JSON error) when the day is unpublished or still in the future; `400` on a
  missing/malformed `date`, `lang` or `mode`.
- `GET /s/<token>` → the share page (OG meta) for a result token; `GET /og/<token>.png` →
  its card image.
- `GET /today` → `{ date, dayNumber, timeZone, resetHour, nextResetAt,
  secondsUntilNextReset }` — a DIAGNOSTIC: the server's current game day and the next
  flip. The client computes the day itself and does not read this.
- `OPTIONS *` → CORS preflight (`204`).

## The day boundary

The active puzzle day flips at **22:00 America/New_York** (NYT-style: a date's puzzle
goes live the evening before). Conversions are **DST-correct** — the NY wall clock is
read via `Intl` with the IANA zone, never a fixed UTC offset. The one definition lives in
`@whippin/shared` (`src/day.ts`), shared with the client that computes the requested date.

A puzzle hit is `max-age=300, s-maxage=31536000`: the URL names its day, so the CDN holds
it until a republish invalidates `/*` (`pnpm puzzle:publish --s3`), while browsers pick a
correction up on a normal reload.

## S3 layout

```
s3://<bucket>/<YYYY-MM-DD>.<lang>.json        — the sentence puzzle
s3://<bucket>/<YYYY-MM-DD>.<lang>.word.json   — Word mode's artifact (#156)
```

The key is fully determined by (game day, lang, mode), so the Lambda `GetObject`s the one
object directly — no `ListObjects` scan — and a flat key stays listable by a date
prefix (`2026-06` for a month, `2026` for a year). The puzzle's words live in the file,
not the key. The publish step (issue #4) maps the generator's
`output/word/<lang>/<kind>/<author>/<work>/<s1>_<s2>_<s3>.json` artifact onto this key
(publish takes a path, so the generator's source-filed layout is invisible here). The
encoding is shared with the local store in `src/layout.ts` (`storeKey`), so local FS and
S3 cannot drift apart.

## Environment

| var             | required | meaning                                          |
| --------------- | -------- | ------------------------------------------------ |
| `PUZZLE_BUCKET` | yes      | S3 bucket holding the daily puzzles              |
| `ALLOWED_ORIGIN`| no       | CORS origin (the web origin in prod; `*` if unset) |
| `SITE_ORIGIN`   | no       | canonical apex for the share card's absolute URLs (falls back to the request origin) |

## Local harness (no AWS) — issue #17

Run the **same `createHandler`** locally, swapping the S3 store for a filesystem store
(`src/fsStore.ts`). The day boundary, 404-no-puzzle, CORS, and `Puzzle` shape are
therefore identical to production — `src/serve.ts` is just a Function-URL ⇄ HTTP adapter.

```bash
# 1. Generate a puzzle (writes it under its source: packages/generation/output/word/
#    <lang>/<kind>/<author>/<work>/<s1>_<s2>_<s3>.json — <lang>/ alone with no source)
pnpm gen:phrase "<sentence>" --lang fr --words a b c

# 2. Publish it into the local store for a chosen day (defaults to local + the active day)
PUZZLE=packages/generation/output/word/fr/book/an-author/a-work/a_b_c.json
pnpm puzzle:publish $PUZZLE                            # local, today
pnpm puzzle:publish $PUZZLE --day 2026-07-01
pnpm puzzle:publish $PUZZLE --s3                       # real S3 (bucket from the stack output)

# 3. Serve it (GET /?lang=<xx>&date=<YYYY-MM-DD>) with no AWS creds
pnpm backend:dev          # http://localhost:8787

# 4. Point the front at it and play end-to-end (the front always loads from the backend)
#    packages/web/.env(.local):  VITE_API_BASE_URL=http://localhost:8787
pnpm dev
```

### Local store layout

Mirrors S3 one-to-one (the prefix is a dir instead of a bucket); encoded once in
`src/layout.ts` (`storeKey`) and shared by the reader (`fsStore`) and writer (`publish`):

```
<store-root>/<YYYY-MM-DD>.<lang>.json
<store-root>/<YYYY-MM-DD>.<lang>.word.json
```

`<YYYY-MM-DD>` is the **game day** (the 22:00-ET day, not the generation day); `<lang>`
is the language. The key is flat and fully determined by (date, lang, mode) — read directly,
no listing — and listable by a date prefix. The store root defaults to
`packages/backend/.local-store` (gitignored); override with `PUZZLE_STORE`.

| var            | default                 | meaning                                   |
| -------------- | ----------------------- | ----------------------------------------- |
| `PORT`         | `8787`                  | local server port (`serve:local`)         |
| `PUZZLE_STORE` | `.local-store`          | local store root read by `fsStore`        |
| `ALLOWED_ORIGIN`| `*`                    | CORS origin                               |
| `SITE_ORIGIN`  | request origin          | apex used for the share card's absolute URLs |

## Dev

```bash
pnpm --filter @whippin/backend test       # vitest (handler + respond + store/layout + publish/inventory + share card)
pnpm --filter @whippin/backend typecheck  # tsc --noEmit
```
