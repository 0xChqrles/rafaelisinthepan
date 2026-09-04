import { defineConfig, configDefaults } from 'vitest/config';

// `cdk.out` IS test files — just not ours. The bot stack's image asset is built from the
// REPO ROOT, so every local `cdk synth`/`deploy` stages the whole context (the bot's `src/`
// included, tests and all) under `cdk.out/asset.<hash>/`. Vitest's default glob then
// collects those copies, which cannot resolve their own dependencies from there and fail as
// a wall of "Failed to load url baileys" — a suite that breaks the moment anyone synths
// locally, and says nothing true when it does. CI never sees it (tests run on a fresh
// checkout, before any synth), which is exactly why it can sit here unnoticed.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'cdk.out/**'] },
});
