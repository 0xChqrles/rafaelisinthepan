# AGENTS.md — @whippin/shared (cross-cutting TS)

> Package-scoped guidance. This package is the HOME of the cross-package contracts:
> the invariants governing what lives here — the slug()⇔fold() identity, the
> per-puzzle JSON schema types, and the day-addressed routing / game-day rules — are
> documented in the root `AGENTS.md`. Read it before touching anything here.

## File map

```
  shared/                     cross-cutting TS consumed by web (pkg @whippin/shared)
    src/slug.ts               fold() — the slug/fold contract (byte-identical to slug())
    src/day.ts                the ONE 22:00-ET DST-correct game-day logic (client + server + publish)
    src/types.ts              per-puzzle schema types (Puzzle, Hole, RankMap, …)
    src/heat.ts               heatColor() — heat ramp (rank exponents + floating hits ONLY)
    src/progressColor.ts      progressColor() + progressEmoji() — progress ramp (progress bar, selector badge, run rulers incl. the card, share-text emoji row); shares ramp.ts
    src/index.ts              re-exports
```

---

## Invariants (pointers)

- Every module here exists to be the ONE source of truth for its concern across
  packages (web + backend + publish). Never fork a second implementation of any of
  them in a consumer package.
- `src/slug.ts` `fold()` must stay byte-identical to generation's Python `slug()`.
  The shared case table is `fixtures/slug-cases.json`, consumed by BOTH languages —
  add a case there, never on one side only (root `AGENTS.md`, Testing).
- `src/day.ts` is the ONE 22:00-ET DST-correct game-day definition (client + server
  + publish) — see the routing contract in the root `AGENTS.md`.
- `src/heat.ts` (heat ramp: rank exponents + floating hits ONLY) and
  `src/progressColor.ts` (progress ramp + `progressEmoji`) are DIFFERENT ramps with
  different meanings — never borrow one for the other's job (they share `ramp.ts`).
  Two web palettes are pinned COPIES of stops from them, which is a different thing
  from borrowing a ramp: the value is taken once and frozen under its own meaning,
  and a test pins each hex to the stop it came from so a retune of the ramp fails
  loudly instead of silently respeaking a stale palette. Those are the route map's
  lane colours (`laneColors.test.ts`) and Word mode's rarity grades
  (`rarity.test.ts`, #163) — the latter copies from BOTH ramps, since what it needed
  was five readable, far-apart, non-red colours and neither ramp alone has them.
- `src/shareCard.ts` is the share-token codec, running byte-identically in the
  browser and the Lambda; the token's product behavior and evolution rules are in the
  solved-result bullet of `packages/web/AGENTS.md`. Its leading VERSION field is a
  **format id in ONE namespace shared by both dailies**: v2 = the sentence result
  (ruler trajectory + solve ticks), **v4 = Word mode's (#156) — the common header
  (`version | lang | day | scoreLen | score`) plus the accented UTF-8 display word used
  by its terminus-style OG card** (decided 2026-08-08; v3's score-only Word payload is
  retired). A future sentence bump must SKIP a value already taken. Each format
  has its own encode/decode pair, neither decodes the other, and
  `decodeLegacyShareTarget`'s "strictly older than the sentence version" rule keeps a
  malformed token of either shape at a flat 404 rather than a redirect.
- Changes here are contract changes by definition: update the Vitest contract tests
  and run `pnpm test` (root testing policy).
