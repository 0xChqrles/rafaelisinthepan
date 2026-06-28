# Rafael is in the pan — monorepo

Daily sentence-reconstruction game. A **pnpm workspaces** monorepo.

## Layout

```
packages/
  web/         React + Vite + TypeScript front end (the game UI + static assets).
  generation/  Python scripts (run via uv) that reduce embeddings and generate
               per-puzzle JSON. Output is written into ../web/public.
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
pnpm install           # installs every workspace (web + shared)
```

Python deps are managed by `uv` inside `packages/generation` (its own
`pyproject.toml` / `uv.lock`); `uv run` provisions them on first use.

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
```

Generated puzzle/vocab JSON lands in `packages/web/public/{word,vocab}`, which the
web dev server and production build serve. See AGENTS.md for the data pipeline
invariants and the per-puzzle schema.
