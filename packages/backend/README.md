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
s3://<bucket>/<YYYY-MM-DD>/<word1>-<word2>-<word3>.<lang>.json
```

The Lambda knows the date + lang but not the words, so it lists the day's prefix and
picks the object ending `.<lang>.json` (issue #4 — the upload step — reconciles this
naming with the generator's `word/<lang>/<s1>_<s2>_<s3>.json` output).

## Environment

| var             | required | meaning                                          |
| --------------- | -------- | ------------------------------------------------ |
| `PUZZLE_BUCKET` | yes      | S3 bucket holding the daily puzzles              |
| `ALLOWED_ORIGIN`| no       | CORS origin (the web origin in prod; `*` if unset) |

## Dev

```bash
pnpm --filter @rafaelisinthepan/backend test       # vitest (day boundary + handler)
pnpm --filter @rafaelisinthepan/backend typecheck  # tsc --noEmit
```
