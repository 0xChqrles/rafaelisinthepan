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
    src/identity.ts           the #187 player key: secret format + publicId derivation (web+backend)
    src/leaderboard.ts        the #190 board rules: competition tie ranks, top-50 cut w/ straddling-tie
                              collapse, own-row window + the Board API types (backend cuts, web renders)
    src/avatar.ts             the #188 avatar: {bg, fg} palettes + the 14-byte 1-bit grid codec (web encodes/renders, backend validates)
    src/name.ts               the #188 display-name charset: sanitizeName (web) ⇔ isValidName (backend)
    src/types.ts              shared puzzle + score-API schema types (Puzzle, Hole, ScoreHistogram, …)
    src/heat.ts               the app's ONE weird→calm stop gradient: heatColor() + fixed-cap rankHeatColor()/HIT_HEAT_CAP (exponents, floating hits, loot, route rows) + progressHeatColor()/progressEmoji() (run rulers incl. the card, share-text emoji row, archive fills, chooser strips)
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
- `src/avatar.ts` is the ONE definition of the #188 avatar encoding (palette byte + 100
  cells × 1 bit — two colours only, user-decided 2026-08-19 — base64url, canonical
  decode) and of `AVATAR_PALETTES`, the `{bg, fg}` pairs extracted from the user's
  repo-root palette drawings (see the root `AGENTS.md`; the editor's picker swatch
  shows the GROUND). The palette list is APPEND-ONLY, since the stored byte is an
  index into it. The
  web encodes what the editor drew and renders every stored avatar; the backend decodes
  to validate and moderate — a fork would accept different strings for one drawing
  (root `AGENTS.md`, Player profile).
- `src/name.ts` is the ONE definition of the #188 display-name charset (user-decided
  2026-08-19: "the server should apply the same rules"). `sanitizeName` is what the web
  writes through on every path — the initial read, keystrokes, a composition's commit,
  the save body — and `isValidName` is simply "the sanitizer leaves it alone", which is
  what the backend refuses a write on. Stating the rule twice would let the editor
  promise a shape the store does not hold, which is exactly what the first cut did (it
  lived in one onChange handler and nothing else in the system knew about it). Accents
  FOLD rather than underscore, and the pipeline normalizes first — the reasoning is in
  the root `AGENTS.md` (Player profile).
- `src/identity.ts` is the ONE definition of the #187 player identity: the 32-hex secret
  format the web generates/stores and the `publicId` derivation (first 10 bytes of
  SHA-256(secret), base32) the backend keys every score row by. The web sends the secret,
  the server derives — two implementations would fork one key into two identities, and
  the derivation test pins a vector for exactly that reason.
- `src/scores.ts` owns `WORD_CLAIM_ZONE` across the web's Word rules and the backend's
  #169 possible-score validation. The web may tune the field without regenerating an
  artifact, but the server must move/deploy with it so a real score is never rejected and
  an impossible one is never admitted. `web/game/wordGame.ts` re-exports it as
  `CLAIM_ZONE` for its existing consumers.
- **`src/heat.ts` is the app's ONE gradient, and it runs WEIRD → CALM (user-decided
  2026-08-17, the calm redesign — superseding the FLIR iron bow of the same day and the
  crimson→cyan heat stops before it).** Solving is RESTORING PEACE to a weird sentence:
  the scale starts at vivid RED (#ff3d2e — the weird terminus, and MISS, red again by
  the user's call once the scale grew one step past the yellow) and runs through amber,
  coral and a strange rose-orchid into the cobalt (#4a6aff — the web's `--solve`, so a
  solved word lands exactly on the scale's terminus). FULLY SATURATED stamp-ink chroma (the
  third cut of the day: dusty read "creepy", mid-saturation read "dull" — the
  /inspiration stamps are vivid inks, and the calm lives in the textures instead), every
  value ≥4.5:1 on the ground (pinned in `heat.test.ts`, along with the walk's monotonic
  blueness). What survived the two earlier ramps is STRUCTURAL and
  still holds: ONE gradient for everything (a % reads straight onto it, so the run ruler,
  the card, the emoji row, the archive fills and the chooser strips can never drift);
  the gradient TERMINATES exactly ON `MISS_COLOR` (which lives here, beside the scale
  that ends on it); and the rank scale STOPS at the 100 exponent (`HIT_HEAT_CAP`) — a
  guess 1000 away, a guess 100 away and a MISS are the same level of weird, told apart
  only by their labels. `progressEmoji` walks 🟥 → 🟨 → 🟪 → 🟦 (weirdest, weird,
  strange, calm; cuts at 15/45/75). `rankHeatColor(rank)` owns that absolute logarithmic
  100-rank scale internally — consumers never supply a per-hole or per-surface denominator,
  so the same rank cannot change colour between renderers.
  One web palette used to be pinned COPIES of ramp stops; with the calm redesign Word
  mode's rarity ladder is AUTHORED instead (`rarity.test.ts` still pins its hexes and
  re-measured dE constraints, so a retune stays a deliberate act).
- `src/leaderboard.ts` is the ONE definition of the #190 board's ranking rules —
  competition-style tie ranks, the top-50 cut that keeps tie groups whole and collapses
  a straddling one, the own-row ±2 window — plus the `Board`/`BoardRow` API types. The
  BACKEND applies them before attaching profiles and the WEB renders what they
  produced; a fork would let the ranks a board shows drift from the rows the server
  selected. Contract-tested per the issue (`leaderboard.test.ts`); the product rules
  live in the root `AGENTS.md` (Leaderboard reads).
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
