# Whippin AI — monorepo

Daily sentence-reconstruction game. A **pnpm workspaces** monorepo.

## Layout

```
packages/
  web/         React + Vite + TypeScript front end (the game UI + static assets).
  generation/  Python embedding reduction + puzzle/vocab generation (run via uv).
  benchmark/   Isolated Python LLM puzzle benchmark and provider dependencies.
  shared/      Cross-cutting TypeScript consumed by web: the slug/fold contract
               and the per-puzzle schema types.
```

Authoritative agent / architecture guidance lives in **AGENTS.md** (`CLAUDE.md`
is a symlink to it). The web app serves a single `public/` (under
`packages/web/public`) that holds both its static assets (flags, font) and the
generated `vocab/` + `word/` JSON produced by the generation package.

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

# LLM benchmark (packages/benchmark — Python via its own uv project)
pnpm bench:puzzle <puzzle.json> --model OPUS
pnpm bench:puzzle <puzzle.json> --model GPT-SOL --auth subscription --effort medium --runs 1
pnpm bench:puzzle <puzzle.json> --model SONNET --auth subscription --effort medium --runs 1
```

Generation splits its two outputs by purpose: **puzzles** land in
`packages/generation/output/word/<lang>/` (a generation artifact you then
`pnpm puzzle:publish` into the daily store — local or S3), while the **vocab**
existence set lands in `packages/web/public/vocab/<lang>.json`, a web runtime asset the
SPA fetches from its own origin. See AGENTS.md for the data pipeline invariants and the
per-puzzle schema.
