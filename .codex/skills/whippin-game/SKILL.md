---
name: whippin-game
description: Build, modify, and validate the Whippin AI React/Vite game in this repository. Use when Codex works on the game UI, `public/game_data.json`, dataset generation, ranking semantics, scoring, language selection, timer/input loop, flat pixel styling, or regression checks for the word-hole gameplay.
---

# Whippin AI

## Overview

Use this skill to preserve the gameplay contract while changing the React app or the data pipeline. The core invariant is that lower rank values are better: `0` is the exact secret, `1` is the nearest neighbor, and larger values are farther away.

## Workflow

1. Read `references/game-contract.md` before editing game behavior, scoring, data, or dataset generation.
2. Inspect the existing components first; the app is intentionally split into small functional components and hooks.
3. Keep gameplay state in hooks/components close to the current structure:
   - `src/screens/Game.jsx` owns input handling, timer state, hole state, invalid feedback, and hit feedback.
   - `src/game/scoring.js` owns rank-to-progress math.
   - `src/components/FloatingHit.jsx` and `src/components/ShakeWord.jsx` isolate animation surfaces.
4. Validate data after changing `public/game_data.json` or `scripts/build_game_data.py`:

```bash
node .codex/skills/whippin-game/scripts/validate_game_data.mjs public/game_data.json
```

5. Run the app checks that match the change:

```bash
npm run build
```

## Data Rules

- Load game data from `/game_data.json`, which maps to `public/game_data.json` in Vite.
- Treat the vocabulary as shared across rank maps. Every `ranks[secret]` used by a hole should expose the same word keys so the game can read `ranks[h.secret][word]` for every hole.
- Reject a guess only when the normalized word is absent from every rank map.
- For a valid guess, compare ranks for every active hole and target the hole with the smallest rank. Replace only if that rank is lower than the target hole's current rank.
- Keep `start_rank` equal to `ranks[secret][start]`, and keep `ranks[secret][secret] === 0`.

## UI Rules

- Use React functional components and hooks.
- Use the local Undertale font from `public/undertale.ttf`; do not import Google Fonts.
- Draw flags in CSS/SVG, never with emoji flags.
- Keep a flat modern UI with pixel-art typography and assets. Avoid scanline overlays, heavy glow effects, and terminal-style neon accents.
- Keep animation behavior structurally isolated in `FloatingHit` and `ShakeWord`; polish can happen later behind those components. Mark temporary animation code with `TODO(anim)`.
- Avoid moving unrelated responsibilities into shared utilities unless it reduces real duplication.

## Resources

- `references/game-contract.md`: concise product and data contract.
- `scripts/validate_game_data.mjs`: dataset validator for generated JSON files.
