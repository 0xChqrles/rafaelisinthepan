// THE NEW SENTENCE (user-decided 2026-10-13: "they need to have an instant reload when there's
// a new sentence"). A republish replaces a day's sentence under every page showing it, and the
// rounds of the retired one are refused (shared `PUZZLE_CHANGED`): a page left on it takes
// guesses that are never kept, and a solve on it is never confirmed. This module RELOADS the
// page onto the new sentence the moment it learns of one, two ways:
//   - a round's write is answered PUZZLE_CHANGED (`notePuzzleChanged`, from `roundSync`), so
//     a player who is guessing reloads within a guess;
//   - the page ASKS — when the round comes on screen, every CHECK_MS while it is seen, and
//     whenever it comes back into view: the puzzle's own URL, revalidated against its ETag
//     (its revision, shared `sentenceVersion.ts`), which the CDN answers 304 for an unchanged
//     sentence — a header, never the puzzle again.
// Unlike a new BUILD (`versionCheck.ts`, which never yanks a visibly active player), a new
// sentence reloads a page IN PLAY at once: what is being played there is no longer kept. A
// round already OVER (solved, given up, capped) loses nothing by waiting, and has a result on
// screen — a share, a group being named — so its reload is HELD until the player looks away
// or comes back (user-decided 2026-10-13): spent the moment the tab is hidden, or on its
// return.
//
// It reloads only on a revision it has READ and that differs from the one on screen, so an
// answer it cannot read (offline, a response with no ETag) never reloads anything — nor onto
// the revision this tab just reloaded AWAY from, which an edge whose invalidation lags may
// still serve for a moment. The new sentence is fetched whole first, into the HTTP cache the
// reloaded page reads; a body that could not be read in time still reloads, and the reloaded
// page's first fetch then asks the CDN again (`takeFreshPuzzle`).

import { useEffect } from 'react';
import { etagRevision } from '@whippin/shared';

export const CHECK_MS = 60_000;
// After PUZZLE_CHANGED the store already holds the new sentence, and the CDN may still serve
// the retired one for the few seconds its invalidation takes: asked again this often, this
// many times, before falling back to the minute.
export const RETRY_MS = 10_000;
export const RETRIES = 6;
// The answer's HEADERS must come within DEADLINE_MS; the new sentence's body (a few hundred
// KB) gets BODY_DEADLINE_MS more, so a slow line still reloads rather than re-downloading it
// on every check.
const DEADLINE_MS = 10_000;
const BODY_DEADLINE_MS = 60_000;
// One reload per RELOAD_GAP_MS at most, so an edge still answering the retired sentence after
// another has answered the new one cannot spin the page.
export const RELOAD_GAP_MS = 30_000;
const RELOADED_AT = 'whippin-sentence-reloaded';
const FRESH_PUZZLE = 'whippin-sentence-fresh';
// `<url> <revision>`: the sentence this tab last reloaded away from.
const LEFT = 'whippin-sentence-left';

export type SentenceAnswer = 'same' | 'changed' | 'unknown';

// What one answer says of the sentence on screen. A 304 reaches `fetch` as the cached 200,
// carrying the cached ETag; anything else — a failure, a day gone, no validator — says
// nothing. `left` is the revision this tab reloaded away from: an edge still serving it is
// behind, never a newer sentence.
export function readAnswer(
  status: number,
  etag: string | null,
  revision: string,
  left: string | null = null,
): SentenceAnswer {
  if (status !== 200) return 'unknown';
  const published = etagRevision(etag);
  if (!published || published === left) return 'unknown';
  return published === revision ? 'same' : 'changed';
}

// The `sessionStorage` PROPERTY itself throws when storage is disabled (versionCheck.ts).
function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

interface Watched {
  url: string;
  revision: string;
}

let watched: Watched | null = null;
// Whether the round on screen is over (`useSentenceWatch`'s `over`).
let over = false;
// A reload found while the round was over, held for the next hide or return.
let held: { target: Watched; stored: boolean } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let asking = false;
let listening = false;

// The revision this tab last reloaded away from at `url`, if any.
function leftRevision(url: string): string | null {
  try {
    const left = sessionStore()?.getItem(LEFT) ?? '';
    const space = left.lastIndexOf(' ');
    return space > 0 && left.slice(0, space) === url ? left.slice(space + 1) : null;
  } catch {
    return null;
  }
}

interface Asked {
  answer: SentenceAnswer;
  // Whether the new sentence's body is in the HTTP cache (read whole), on 'changed'.
  stored: boolean;
}

async function ask(target: Watched): Promise<Asked> {
  // A deadline of its own (never `AbortSignal.timeout()`, `timeout.ts`), re-armed for the body.
  const controller = new AbortController();
  let deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const response = await fetch(target.url, { cache: 'no-cache', signal: controller.signal });
    clearTimeout(deadline);
    const answer = readAnswer(
      response.status,
      response.headers.get('ETag'),
      target.revision,
      leftRevision(target.url),
    );
    if (answer !== 'changed') {
      await response.body?.cancel();
      return { answer, stored: false };
    }
    // The new sentence is read WHOLE, so the reload finds it in the cache.
    deadline = setTimeout(() => controller.abort(), BODY_DEADLINE_MS);
    try {
      await response.arrayBuffer();
      return { answer, stored: true };
    } catch {
      return { answer, stored: false };
    }
  } catch {
    return { answer: 'unknown', stored: false };
  } finally {
    clearTimeout(deadline);
  }
}

function reload(target: Watched, stored: boolean): boolean {
  const store = sessionStore();
  try {
    const last = Number(store?.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < RELOAD_GAP_MS) return false;
    store?.setItem(RELOADED_AT, String(Date.now()));
    store?.setItem(LEFT, `${target.url} ${target.revision}`);
    if (stored) store?.removeItem(FRESH_PUZZLE);
    else store?.setItem(FRESH_PUZZLE, target.url);
  } catch {
    // Storage that cannot be written cannot bound the reloads; the one asked for still goes.
  }
  window.location.reload();
  return true;
}

function clear(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function schedule(ms: number): void {
  clear();
  timer = setTimeout(() => void tick(), ms);
}

async function tick(): Promise<void> {
  timer = null;
  // The ask in flight schedules the next one when it lands.
  if (asking) return;
  const target = watched;
  // A page out of view asks nothing; coming back into view asks at once.
  if (!target || document.visibilityState !== 'visible') return;
  asking = true;
  const { answer, stored } = await ask(target);
  asking = false;
  if (watched !== target) {
    // Another sentence came on screen meanwhile (its own first ask bailed on this one):
    // ask about it now.
    if (watched) schedule(0);
    return;
  }
  if (answer === 'changed') {
    if (over) {
      // Nothing more to learn: the reload waits for the next hide or return.
      held = { target, stored };
      return;
    }
    if (reload(target, stored)) return;
  }
  if (retries > 0) {
    retries -= 1;
    schedule(RETRY_MS);
  } else {
    schedule(CHECK_MS);
  }
}

// The held reload, spent: a reload refused by the gap leaves the watch asking as before.
function spendHeld(): void {
  const owed = held;
  held = null;
  if (owed && watched === owed.target && !reload(owed.target, owed.stored)) schedule(CHECK_MS);
}

function onShown(event?: Event): void {
  // A pageshow counts only as a bfcache restore; the first load is the watch's own start.
  if (event && 'persisted' in event && !(event as PageTransitionEvent).persisted) return;
  if (held) {
    // Looking away, or coming back: either way nobody is reading the result any more.
    spendHeld();
    return;
  }
  if (document.visibilityState === 'visible') {
    if (watched) schedule(0);
  } else {
    clear();
  }
}

// The round's write was answered PUZZLE_CHANGED: ask now, and again shortly while the CDN
// catches up.
export function notePuzzleChanged(): void {
  if (!watched) return;
  retries = RETRIES;
  schedule(0);
}

// Watch the sentence on screen: `url` is the puzzle's own (the fetch the page loaded it
// with, so its revalidation is that cache entry's), `revision` the one shown. Returns the
// stop.
export function watchSentence(url: string, revision: string): () => void {
  const target = { url, revision };
  watched = target;
  retries = 0;
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', () => onShown());
    // A bfcache restore hands back the live page with no network: the same return.
    window.addEventListener('pageshow', onShown);
  }
  schedule(0);
  return () => {
    if (watched !== target) return;
    watched = null;
    held = null;
    clear();
  };
}

// Whether the round on screen is OVER: a new sentence found then waits for the next hide or
// return instead of reloading the result away.
export function noteRoundOver(value: boolean): void {
  over = value;
}

export function useSentenceWatch(url: string | null, revision: string | null, roundOver: boolean): void {
  useEffect(() => (url && revision ? watchSentence(url, revision) : undefined), [url, revision]);
  useEffect(() => noteRoundOver(roundOver), [roundOver]);
}

// Whether the page was reloaded onto a new sentence at `url`: its first fetch of that URL
// then asks the CDN again instead of trusting the cache. Read once.
export function takeFreshPuzzle(url: string): boolean {
  const store = sessionStore();
  try {
    if (store?.getItem(FRESH_PUZZLE) !== url) return false;
    store.removeItem(FRESH_PUZZLE);
    return true;
  } catch {
    return false;
  }
}

// TEST-ONLY: forget everything between tests.
export function resetSentenceWatch(): void {
  watched = null;
  over = false;
  held = null;
  clear();
  retries = 0;
  asking = false;
  listening = false;
}
