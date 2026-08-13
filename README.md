# Whippin AI — monorepo

Daily sentence-reconstruction game. A **pnpm workspaces** monorepo.

## Layout

```
packages/
  web/         React + Vite + TypeScript front end (the game UI + static assets).
  generation/  Python embedding reduction + puzzle/vocab generation (run via uv).
  benchmark/   Isolated Python LLM puzzle benchmark and provider dependencies (lab only).
  backend/     Daily-puzzle backend: one handler for Lambda + local serve, the store, publish.
  infra/       AWS CDK app: the backend and web-hosting stacks (plus the CI deploy role).
  shared/      Cross-cutting TypeScript consumed by web AND bundled into the backend
               Lambda: the slug/fold contract, the schema types, the game day, the
               share-card codec.
```

Authoritative agent / architecture guidance lives in **AGENTS.md** (`CLAUDE.md`
is a symlink to it). The web app serves a single `public/` (under
`packages/web/public`) that holds both its static assets (flags, font) and the
generated `vocab/<lang>.json` existence set produced by the generation package.
Puzzles are generation artifacts, published to the daily store and served by the
backend — they never live under `public/`.

## Setup

Requires [pnpm](https://pnpm.io) (pinned via the root `packageManager` field; with
[corepack](https://nodejs.org/api/corepack.html) it is provisioned automatically).

```bash
pnpm install           # installs every workspace
```

Python deps are managed by `uv` independently inside `packages/generation` and
`packages/benchmark` (each has its own `pyproject.toml` / `uv.lock`); `uv run`
provisions them on first use.

## Commands

Run from the repo root (each delegates to the right workspace via `pnpm --filter`),
or from inside the package itself. Unlike npm, pnpm forwards script args directly —
do **not** add a `--` separator.

```bash
# Front end (packages/web)
pnpm dev               # vite dev server
pnpm build             # production build -> packages/web/dist
pnpm preview           # preview the production build
pnpm typecheck         # tsc --noEmit

# Generation (packages/generation — Python via uv)
pnpm reduce:fr         # embedding/fr/cc.fr.300.vec      -> cc.fr.300_reduced.vec
pnpm reduce:en         # embedding/en/glove.6B.300d.txt  -> glove.6B.300d_reduced.txt
pnpm gen:phrase "<sentence>" --lang fr --words a b c   # exactly 3 words (no `--`)

# LLM benchmark (packages/benchmark — Python via its own uv project; lab readings only)
# Native persistent sessions are the product default; use --session stateless only
# for fresh-turn complete-record diagnostics. --runs N repeats a full run (default 1).
pnpm bench:puzzle <puzzle.json> --model OPUS
pnpm bench:puzzle <puzzle.json> --model SONNET --auth subscription --effort medium
KIMI_CODE_API_KEY=... pnpm bench:puzzle <puzzle.json> --model KIMI --auth subscription --effort medium
```

Generation splits its two outputs by purpose: **puzzles** land in
`packages/generation/output/word/<lang>/<kind>/<author>/<work>/`, filed under their
source metadata — levels you did not provide are omitted, so a puzzle with no source
stays at `<lang>/` (a generation artifact you then
`pnpm puzzle:publish` into the daily store — local or S3), while the **vocab**
existence set lands in `packages/web/public/vocab/<lang>.json`, a web runtime asset the
SPA fetches from its own origin. See AGENTS.md for the data pipeline invariants and the
per-puzzle schema.
