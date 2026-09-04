// WHAT TODAY'S SENTENCE IS FROM (#236, user-decided 2026-09-04): the day's `source`
// metadata, read once per (language, day) and carried in the CONVERSATION's system prompt
// rather than fetched through a tool.
//
// IT IS AMBIENT, NOT ASKED FOR. A tool would mean the model has to decide to call it, and
// then a round trip mid-conversation before it can answer "c'est tiré de quoi ?" — while
// the fact is one small object that does not change all day. So it is loaded like the day
// number beside it: known before the question is read.
//
// WHAT MAY BE SAID IS NOT WHAT IS KNOWN. The bot holds the whole object and may name only
// the KIND — "c'est une chanson" is flavour, where the author and the work are the answer
// itself (knowing today's line is "Oiseau" by Bertrand Belin means looking up the lyrics).
// The rule travels with the fact, in `sourceContext` below, because this is the only prompt
// that carries it: the share line and the podium comments are told nothing about the source
// and so have nothing to leak.

import type { Log } from '../log';

// The shape the puzzle carries (#5). EVERY field is independently optional, so partial
// metadata is valid and a puzzle may carry no `source` at all.
export interface DaySource {
  kind?: string; // book | movie | music | quote | poem | … (an OPEN set)
  author?: string;
  work?: string;
}

const FETCH_TIMEOUT_MS = 15_000;
// A FAILURE IS REMEMBERED BRIEFLY, an ANSWER for the process's life. A 404 is an answer —
// that day was never published — and a source does not change while a day is live, so
// re-reading it would be several megabytes per conversation. A network failure is not an
// answer, and retrying it on the very next message would hammer the API at the rate the
// group talks; it is held for this long instead.
const FAILURE_TTL_MS = 5 * 60_000;

interface Entry {
  source: DaySource | null;
  // Absent = settled for good. Set = a failure that may be retried after this instant.
  retryAfter?: number;
}

export interface DaySourceReader {
  // The day's source, or null when there is none to have — an unpublished day, a puzzle
  // with no metadata, or a read that failed. A caller never distinguishes those: all three
  // mean the prompt says nothing about where the sentence came from.
  get(lang: string, day: number, date: string): Promise<DaySource | null>;
}

export interface DaySourceDeps {
  apiBaseUrl: string;
  log: Log;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

// THE PUZZLE IS PARSED, NEVER SCANNED. `"source"` occurs three times in a real French
// artifact — twice as a RANK-MAP KEY, because *source* is an ordinary French word, and once
// as the object wanted (measured on 2026-09-03: hits at 4.3%, 56.1% and 100% of the file).
// A regex for it finds `{"word":"sources","rank":1452}` first and confidently reports the
// day's sentence comes from a work called "sources".
//
// It costs a 4-6 MB download and parse, ONCE per language per day, and everything but this
// one small object is dropped immediately. That is the whole price of the feature.
export function createDaySourceReader(deps: DaySourceDeps): DaySourceReader {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? fetch;
  const cache = new Map<string, Entry>();

  async function load(lang: string, date: string): Promise<Entry> {
    const url = `${deps.apiBaseUrl}/?lang=${encodeURIComponent(lang)}&date=${encodeURIComponent(date)}`;
    let response: Response;
    try {
      response = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      deps.log.warn(
        { event: 'source.unreachable', lang, date, error: (error as Error).message },
        'could not read the day; the bot simply will not know where the sentence is from',
      );
      return { source: null, retryAfter: now() + FAILURE_TTL_MS };
    }
    // 404 is the day-addressed answer for a day that was never published — settled, not a
    // failure, so it is not retried every five minutes for the rest of the day.
    if (response.status === 404) {
      deps.log.info({ event: 'source.none', lang, date }, 'no puzzle published for this day');
      return { source: null };
    }
    if (!response.ok) {
      deps.log.warn({ event: 'source.failed', lang, date, status: response.status }, 'the day did not load');
      return { source: null, retryAfter: now() + FAILURE_TTL_MS };
    }
    let puzzle: { source?: DaySource };
    try {
      puzzle = (await response.json()) as { source?: DaySource };
    } catch (error) {
      deps.log.warn(
        { event: 'source.unparseable', lang, date, error: (error as Error).message },
        'the day did not parse',
      );
      return { source: null, retryAfter: now() + FAILURE_TTL_MS };
    }
    const source = puzzle.source ?? null;
    // Never the author or the work: this is a log, and a log of what today's answer is
    // from would spoil the day for whoever reads it.
    deps.log.info({ event: 'source.loaded', lang, date, kind: source?.kind ?? null }, 'day source loaded');
    return { source };
  }

  // One flight per (language, day), shared: a lively group can address the bot several
  // times inside one 4-6 MB read, and each of those must not start its own.
  const flights = new Map<string, Promise<Entry>>();

  return {
    async get(lang, day, date) {
      const key = `${lang}#${day}`;
      const held = cache.get(key);
      if (held && (held.retryAfter === undefined || held.retryAfter > now())) return held.source;
      const flight =
        flights.get(key) ??
        load(lang, date).then((entry) => {
          cache.set(key, entry);
          flights.delete(key);
          return entry;
        });
      flights.set(key, flight);
      try {
        return (await flight).source;
      } catch {
        flights.delete(key);
        return null;
      }
    },
  };
}

// THE FACT AND THE RULE TOGETHER, because the rule is only true where the fact is. Nothing
// says "you know today's source" to a prompt that was not given one: the share line and the
// podium comments carry neither, so there is nothing there to hold back.
//
// The KIND is the half that may be said. It is a genuine piece of colour a group enjoys
// ("c'est une chanson aujourd'hui") and it narrows nothing — where the author and the work
// ARE the sentence, one search away.
export function sourceContext(source: DaySource | null): string {
  if (!source) return '';
  const known: string[] = [];
  if (source.kind) known.push(`kind: ${source.kind}`);
  if (source.author) known.push(`author: ${source.author}`);
  if (source.work) known.push(`work: ${source.work}`);
  if (known.length === 0) return '';
  return (
    `Where today's sentence comes from (${known.join(', ')}). ` +
    `You may say the KIND freely — that it is a song, a book, a poem — it is colour and it gives nothing away. ` +
    `You may NOT name the author or the work, hint at either, or confirm or deny somebody else's guess at them, ` +
    `not even when asked directly and not even to one person: anybody who has not played yet is reading, ` +
    `and the title is one search away from the whole sentence. Say you know and are not telling.`
  );
}
