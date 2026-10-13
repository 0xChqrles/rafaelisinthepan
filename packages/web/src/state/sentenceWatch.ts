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
// sentence reloads a page in play too: what is being played there is no longer kept.
//
// It reloads only on a revision it has READ and that differs from the one on screen, so an
// answer it cannot read (offline, a response with no ETag) never reloads anything; and the
// new sentence is fetched whole first, into the HTTP cache the reloaded page reads (asked
// fresh once more there, `takeFreshPuzzle`, should a browser not have kept it).

import { useEffect } from 'react';
import { etagRevision } from '@whippin/shared';
import { timeoutSignal } from '../timeout';

export const CHECK_MS = 60_000;
// After PUZZLE_CHANGED the store already holds the new sentence, and the CDN may still serve
// the retired one for the few seconds its invalidation takes: asked again this often, this
// many times, before falling back to the minute.
export const RETRY_MS = 10_000;
export const RETRIES = 6;
const DEADLINE_MS = 10_000;
// One reload per RELOAD_GAP_MS at most, so an edge still answering the retired sentence after
// another has answered the new one cannot spin the page.
export const RELOAD_GAP_MS = 30_000;
const RELOADED_AT = 'whippin-sentence-reloaded';
const FRESH_PUZZLE = 'whippin-sentence-fresh';

export type SentenceAnswer = 'same' | 'changed' | 'unknown';

// What one answer says of the sentence on screen. A 304 reaches `fetch` as the cached 200,
// carrying the cached ETag; anything else — a failure, a day gone, no validator — says
// nothing.
export function readAnswer(status: number, etag: string | null, revision: string): SentenceAnswer {
  if (status !== 200) return 'unknown';
  const published = etagRevision(etag);
  if (!published) return 'unknown';
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
let timer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let asking = false;
let listening = false;

async function ask(target: Watched): Promise<SentenceAnswer> {
  try {
    const response = await fetch(target.url, { cache: 'no-cache', signal: timeoutSignal(DEADLINE_MS) });
    const answer = readAnswer(response.status, response.headers.get('ETag'), target.revision);
    // The new sentence is read WHOLE, so the reload finds it in the cache; any other body is
    // dropped unread.
    if (answer === 'changed') await response.arrayBuffer();
    else await response.body?.cancel();
    return answer;
  } catch {
    return 'unknown';
  }
}

function reload(url: string): boolean {
  const store = sessionStore();
  try {
    const last = Number(store?.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < RELOAD_GAP_MS) return false;
    store?.setItem(RELOADED_AT, String(Date.now()));
    store?.setItem(FRESH_PUZZLE, url);
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
  const target = watched;
  // A page out of view asks nothing; coming back into view asks at once.
  if (!target || asking || document.visibilityState !== 'visible') return;
  asking = true;
  const answer = await ask(target);
  asking = false;
  if (watched !== target) return;
  if (answer === 'changed' && reload(target.url)) return;
  if (retries > 0) {
    retries -= 1;
    schedule(RETRY_MS);
  } else {
    schedule(CHECK_MS);
  }
}

function onShown(event?: Event): void {
  // A pageshow counts only as a bfcache restore; the first load is the watch's own start.
  if (event && 'persisted' in event && !(event as PageTransitionEvent).persisted) return;
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
    clear();
  };
}

export function useSentenceWatch(url: string | null, revision: string | null): void {
  useEffect(() => (url && revision ? watchSentence(url, revision) : undefined), [url, revision]);
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
  clear();
  retries = 0;
  asking = false;
  listening = false;
}
