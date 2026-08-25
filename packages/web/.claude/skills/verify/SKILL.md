---
name: verify
description: Build, launch, and drive the Whippin web SPA to observe a change at its real surface (browser), including how to load an arbitrary test puzzle via the local backend.
---

# Verify a @whippin/web change in the running app

## Launch

The front ALWAYS loads the day's puzzle from the backend (there is no client-side
file/URL override), so run the local backend harness beside the dev server:

```bash
pnpm backend:dev                                        # local store server on :8787 — background it
cd packages/web && pnpm dev --port 5199 --strictPort    # background it too
```

`packages/web/.env.local` must point at it: `VITE_API_BASE_URL=http://localhost:8787`.

## Load a controlled puzzle

Publish a hand-written puzzle JSON into the local store for the active game day,
then open the game normally:

```bash
pnpm puzzle:publish /path/to/your-test-puzzle.json   # defaults: local store + active 22:00-ET day
open http://localhost:5199/en
```

- The publish echoes the store file it wrote
  (`packages/backend/.local-store/<date>.<lang>.json`) — that (date, lang) is what
  the client will fetch. Re-publishing the same day overwrites it.
- A first visit shows the tutorial invitation — just drive its SKIP button, or
  pre-seed the game database (IndexedDB since v18 — `state/gamePersistence.ts`;
  localStorage no longer holds game state) in the browser context before load:

  ```js
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('whippin-game', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('state');
    open.onsuccess = () => {
      const tx = open.result.transaction('state', 'readwrite');
      // version must match GAME_PERSIST_VERSION (src/state/gameStore.ts); a mismatch
      // just runs migratePersisted, which fills every missing field, so `onboarded`
      // is all the seed needs.
      tx.objectStore('state').put({ version: 18, state: { onboarded: true } }, 'game');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  }));
  ```
- The SERVER owns a sentence round's log since #214 — what persists locally is only
  the unacknowledged OUTBOX (and Word mode's clock/outbox). To restart a round,
  restart `pnpm backend:dev` (its in-memory rounds AND devices reset — the app then
  shows START FRESH, exactly like a wiped production table) or use a fresh browser
  context.
- Every guess you type must exist in the committed vocab
  (`public/vocab/<lang>.json`) or it is rejected as INVALID. Check first:
  `node -e "console.log(new Set(require('./public/vocab/en.json')).has('word'))"`.
  Beware surprises: `zzz` IS an English vocab word; single letters are not.
- Keep the puzzle's `ranks` small and hand-written (secret at rank 0) so you can
  script exact distances. **Delete the test day from
  `packages/backend/.local-store/` when done** (it is gitignored, but a stale
  fixture will shadow a real published puzzle).

## Drive it

Playwright works headless with the cached Chromium; install it in the scratchpad
(`npm i playwright`), not the repo. The game has no native input — type via
`page.keyboard.type(word)` + `Enter` (a window keydown listener feeds the game).
Useful hooks:

- Live count / score watermark: `.progress-background` text.
- Persisted state: IndexedDB `whippin-game` → object store `state`, key `game` →
  `.state.outbox` (unacknowledged sentence guesses) / `.state.wordRounds` (the #214
  rounds map and `solvedDays` no longer exist).
- SR live region: `.sr-only[role="status"]` text.
- Reduced motion: `page.emulateMedia({ reducedMotion: 'reduce' })` (global CSS
  collapses durations, never removes animations; standalone infinite decorations
  are `animation: none`-disabled instead).
- Mobile: viewport 375×667; assert no horizontal overflow
  (`scrollWidth > clientWidth` on documentElement must be false).

Guess feedback choreography is delayed (~320ms stagger + fades + 600ms word
blink): wait ~1.5s after each Enter before reading state, and note that an
INVALID submit KEEPS the input (backspace it before the next word).
