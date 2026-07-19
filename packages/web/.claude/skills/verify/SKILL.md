---
name: verify
description: Build, launch, and drive the Whippin web SPA to observe a change at its real surface (browser), including how to load an arbitrary test puzzle without a backend.
---

# Verify a @whippin/web change in the running app

## Launch

```bash
cd packages/web && pnpm dev --port 5199 --strictPort   # background it
```

`.env.local` already sets `VITE_API_BASE_URL` (required even when bypassing the
backend). No backend needed if you drive via the `?puzzle=` override.

## Load a controlled puzzle

Drop a puzzle JSON into `packages/web/public/` (served at the site root) and open:

```
http://localhost:5199/en?puzzle=/your-test-puzzle.json
```

- The override suppresses the first-visit tutorial invitation and uses a per-load
  round nonce, so every reload starts a fresh round (nothing persisted to reuse).
- Every guess you type must exist in the committed vocab
  (`public/vocab/<lang>.json`) or it is rejected as INVALID. Check first:
  `node -e "console.log(new Set(require('./public/vocab/en.json')).has('word'))"`.
  Beware surprises: `zzz` IS an English vocab word; single letters are not.
- Keep the puzzle's `ranks` small and hand-written (secret at rank 0) so you can
  script exact distances. **Delete the test file from `public/` when done.**

## Drive it

Playwright works headless with the cached Chromium; install it in the scratchpad
(`npm i playwright`), not the repo. The game has no native input — type via
`page.keyboard.type(word)` + `Enter` (a window keydown listener feeds the game).
Useful hooks:

- Live count / score watermark: `.progress-background` text.
- Persisted round state: `localStorage['whippin-round']` →
  `.state.rounds[<activeKey>].tried` / `.guessCount`.
- SR live region: `.sr-only[role="status"]` text.
- Reduced motion: `page.emulateMedia({ reducedMotion: 'reduce' })` (global CSS
  collapses durations, never removes animations).
- Mobile: viewport 375×667; assert no horizontal overflow
  (`scrollWidth > clientWidth` on documentElement must be false).

Guess feedback choreography is delayed (~320ms stagger + fades + 600ms word
blink): wait ~1.5s after each Enter before reading state, and note that an
INVALID submit KEEPS the input (backspace it before the next word).
