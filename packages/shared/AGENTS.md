# AGENTS.md — @whippin/shared (cross-cutting TS)

> Package-scoped guidance. This package is the HOME of the cross-package contracts:
> the invariants governing what lives here — the slug()⇔fold() identity, the
> per-puzzle JSON schema types, and the day-addressed routing / game-day rules — are
> documented in the root `AGENTS.md`. Read it before touching anything here.

## File map

```
  shared/                     cross-cutting TS consumed by web + backend (pkg @whippin/shared)
    src/slug.ts               fold() — the slug/fold contract (byte-identical to slug())
    src/day.ts                the ONE 22:00-ET DST-correct game-day logic (client + server + publish)
    src/scores.ts             WORD_CLAIM_ZONE (web+backend) + VIEWER_IP_HEADER (infra+backend)
    src/types.ts              shared puzzle + score-API schema types (Puzzle, Hole, ScoreHistogram, …)
    src/heat.ts               heatColor() — heat ramp (rank exponents + floating hits ONLY)
    src/progressColor.ts      progressColor() + progressEmoji() — progress ramp (progress bar, selector badge, run rulers incl. the card, share-text emoji row); shares ramp.ts
    src/ramp.ts               the piecewise interpolator both ramps share (internal)
    src/shareCard.ts          the share-token codec (both modes), browser + Lambda
    src/cardSvg.ts            the OG card's SVG, rendered from a decoded token
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
- `src/scores.ts` also owns `VIEWER_IP_HEADER`, the header the CDN's viewer-request
  function stamps the connecting address into and the ONLY client address the score handler
  trusts (#169). It lives here because INFRA writes it and the BACKEND reads it, and a
  drift is a 500 on every score POST that no local run can reproduce; the reason it is a
  stamped header rather than CloudFront's own `CloudFront-Viewer-Address` is recorded in
  the root `AGENTS.md`.
- `src/scores.ts` owns `WORD_CLAIM_ZONE` across the web's Word rules and the backend's
  #169 possible-score validation. The web may tune the field without regenerating an
  artifact, but the server must move/deploy with it so a real score is never rejected and
  an impossible one is never admitted. `web/game/wordGame.ts` re-exports it as
  `CLAIM_ZONE` for its existing consumers.
- `src/heat.ts` (heat ramp: rank exponents + floating hits ONLY) and
  `src/progressColor.ts` (progress ramp + `progressEmoji`) are DIFFERENT ramps with
  different meanings — never borrow one for the other's job (they share `ramp.ts`).
  One web palette is a pinned COPY of stops from them, which is a different thing
  from borrowing a ramp: the value is taken once and frozen under its own meaning,
  and a test pins each hex to the stop it came from so a retune of the ramp fails
  loudly instead of silently respeaking a stale palette. That is Word mode's rarity
  grades (`rarity.test.ts`, #163) — it copies from BOTH ramps, since what it needed
  was five readable, far-apart, non-red colours and neither ramp alone has them.
- `src/shareCard.ts` is the share-token codec, running byte-identically in the
  browser and the Lambda; the token's product behavior and evolution rules are in the
  solved-result bullet of `packages/web/AGENTS.md`. Its leading VERSION field is a
  **format id in ONE namespace shared by both dailies**: v2 = the sentence result
  (ruler trajectory + solve ticks), **v5 = Word mode's (#156) — the common
  `version | lang | day` opening, then ONE claim count per rarity grade (commonest first,
  `WORD_RARITY_GRADES` = 5; the claim count a surface names is DERIVED as their sum,
  `wordShareScore`, never stored), then the accented UTF-8 display word its OG card draws** (decided 2026-08-11, superseding v4's single score so the
  share surfaces can break the score down by rarity; v3 and v4 are retired). A future
  sentence bump must SKIP a value already taken. The card's rarity chip row paints
  `cardSvg.ts`'s `WORD_RARITY_COLORS` — a pinned one-way COPY of the web's
  `RARITY_COLORS`, asserted identical by the web's `rarity.test.ts`. Each format
  has its own encode/decode pair, neither decodes the other, and
  `decodeLegacyShareTarget`'s "strictly older than the sentence version" rule keeps a
  malformed token of either shape at a flat 404 rather than a redirect.
- Changes here are contract changes by definition: update the Vitest contract tests
  and run `pnpm test` (root testing policy).
