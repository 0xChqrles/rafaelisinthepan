import { describe, expect, it, vi } from 'vitest';
import { createLog, type Log } from '../log';
import { createDaySourceReader, sourceContext } from './daySource';

const log = createLog('silent');

function reader(responses: (() => Promise<Response> | Response)[], now = () => 1_000) {
  let n = 0;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const next = responses[Math.min(n, responses.length - 1)];
    n += 1;
    return next();
  });
  return {
    calls,
    fetchImpl,
    reader: createDaySourceReader({
      apiBaseUrl: 'https://api.whippin.ai',
      log,
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe("the day's source is ambient context, not a tool (#236)", () => {
  it('reads the day once and holds it, however often the group speaks', async () => {
    const r = reader([() => ok({ source: { kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' } })]);
    expect(await r.reader.get('fr', '2026-09-03')).toEqual({
      kind: 'music',
      author: 'Bertrand Belin',
      work: 'Oiseau',
    });
    await r.reader.get('fr', '2026-09-03');
    await r.reader.get('fr', '2026-09-03');
    // One 4-6 MB read a day, not one per question.
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.calls[0]).toBe('https://api.whippin.ai/?lang=fr&date=2026-09-03');
  });

  it('shares ONE flight when a lively group asks during the read', async () => {
    let release: (v: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const r = reader([() => pending]);
    const all = Promise.all([
      r.reader.get('fr', '2026-09-03'),
      r.reader.get('fr', '2026-09-03'),
      r.reader.get('fr', '2026-09-03'),
    ]);
    release(ok({ source: { kind: 'book' } }));
    expect(await all).toEqual([{ kind: 'book' }, { kind: 'book' }, { kind: 'book' }]);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by DAY and by LANGUAGE — two dailies are two sources', async () => {
    const r = reader([() => ok({ source: { kind: 'music' } }), () => ok({ source: { kind: 'poem' } }), () => ok({ source: { kind: 'book' } })]);
    expect(await r.reader.get('fr', '2026-09-03')).toEqual({ kind: 'music' });
    expect(await r.reader.get('en', '2026-09-03')).toEqual({ kind: 'poem' });
    expect(await r.reader.get('fr', '2026-09-04')).toEqual({ kind: 'book' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('PARSES the puzzle, because "source" is also an ordinary French word', async () => {
    // A real fr artifact holds `"source"` three times: twice as a RANK-MAP KEY and once as
    // the object wanted. A regex for it reports the sentence comes from a work called
    // "sources" — confidently, and wrongly.
    const r = reader([
      () =>
        ok({
          lang: 'fr',
          ranks: {
            serpent: { source: { word: 'sources', rank: 1452, dq: 66 } },
            pierres: { source: { word: 'sources', rank: 6188, dq: 20 } },
          },
          source: { kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' },
        }),
    ]);
    expect(await r.reader.get('fr', '2026-09-03')).toEqual({
      kind: 'music',
      author: 'Bertrand Belin',
      work: 'Oiseau',
    });
  });

  it('an unpublished day is an ANSWER, re-asked every few minutes; a failure is retried later', async () => {
    let at = 1_000;
    const missing = reader([() => new Response('', { status: 404 }), () => ok({ source: { kind: 'book' } })], () => at);
    expect(await missing.reader.get('fr', '2026-09-03')).toBeNull();
    await missing.reader.get('fr', '2026-09-03');
    expect(missing.fetchImpl).toHaveBeenCalledTimes(1); // an answer: not re-read at the rate the group talks
    // …but not for the process's life (v22): the day published late is read once it is.
    at += 6 * 60_000;
    expect(await missing.reader.read('fr', '2026-09-03')).toMatchObject({ published: true, source: { kind: 'book' } });

    let clock = 1_000;
    const down = reader(
      [() => new Response('', { status: 503 }), () => ok({ source: { kind: 'music' } })],
      () => clock,
    );
    expect(await down.reader.get('fr', '2026-09-03')).toBeNull();
    await down.reader.get('fr', '2026-09-03');
    expect(down.fetchImpl).toHaveBeenCalledTimes(1); // not re-read at the rate the group talks
    clock += 6 * 60_000;
    expect(await down.reader.get('fr', '2026-09-03')).toEqual({ kind: 'music' });
  });

  it('an unreachable API is a failure too: read again once the failure TTL has passed', async () => {
    // A fetch that REJECTS is answered inside `load` (`source.unreachable`) and held like a
    // 503 — never a settled answer for the life of the process.
    let clock = 1_000;
    const r = reader(
      [
        () => Promise.reject(new Error('boom')),
        () => ok({ source: { kind: 'poem' } }),
      ],
      () => clock,
    );
    expect(await r.reader.get('fr', '2026-09-03')).toBeNull();
    clock += 6 * 60_000;
    expect(await r.reader.get('fr', '2026-09-03')).toEqual({ kind: 'poem' });
  });

  it('a puzzle with no source, an unreachable API and a broken body all read as NOTHING', async () => {
    const none = reader([() => ok({ lang: 'fr', words: [] })]);
    expect(await none.reader.get('fr', '2026-09-03')).toBeNull();
    const dead = reader([
      () => {
        throw new Error('ECONNREFUSED');
      },
    ]);
    expect(await dead.reader.get('fr', '2026-09-03')).toBeNull();
    const junk = reader([() => new Response('<html>', { status: 200 })]);
    expect(await junk.reader.get('fr', '2026-09-03')).toBeNull();
  });

  it('a body that PARSES but is not an object is an answer, not a thrown error', async () => {
    // `null`, `[]` and a bare string are all valid JSON, so the parse SUCCEEDS — and
    // reading `.source` off `null` then throws. Outside the try that TypeError escaped the
    // whole caching path, so a backend answering `200 null` was re-read at the rate the
    // group talks. Read safely it is simply a day with no source: settled, quiet, one read.
    for (const body of ['null', '[]', '"whippin"']) {
      const r = reader([() => new Response(body, { status: 200 })]);
      expect(await r.reader.get('fr', '2026-09-03')).toBeNull();
      await r.reader.get('fr', '2026-09-03');
      expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the source is his to talk about; the sentence is not (v23)', () => {
  it('carries the whole source, and holds back only the sentence', () => {
    const text = sourceContext({ kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' });
    expect(text).toContain('kind: music');
    expect(text).toContain('author: Bertrand Belin');
    expect(text).toContain('work: Oiseau');
    expect(text).toMatch(/the author and the work included/);
    expect(text).toMatch(/never recite the sentence itself or its hidden words/);
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(sourceContext(null)).toBe('');
    expect(sourceContext({})).toBe('');
  });

  it('states only the fields the day actually carries — every one is optional (#5)', () => {
    const facts = (s: Parameters<typeof sourceContext>[0]) =>
      /\(([^)]*)\)/.exec(sourceContext(s))?.[1] ?? '';
    expect(facts({ kind: 'quote' })).toBe('kind: quote');
    expect(facts({ author: 'Victor Hugo' })).toBe('author: Victor Hugo');
    expect(facts({ kind: 'book', work: 'Les Misérables' })).toBe('kind: book, work: Les Misérables');
  });
});

describe('a reply never waits on decoration (PR-247 review)', () => {
  it('gives up waiting, then has the answer for the next message', async () => {
    vi.useFakeTimers();
    try {
      let release: (v: Response) => void = () => {};
      const slow = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const r = reader([() => slow]);

      // The first question after a restart finds an empty cache and a multi-megabyte read.
      // It answers without the source rather than putting that read in front of the model.
      const first = r.reader.get('fr', '2026-09-03');
      await vi.advanceTimersByTimeAsync(1_600);
      expect(await first).toBeNull();

      // The read was never abandoned: it lands, and the group's next message has it.
      release(ok({ source: { kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await r.reader.get('fr', '2026-09-03')).toEqual({
        kind: 'music',
        author: 'Bertrand Belin',
        work: 'Oiseau',
      });
      expect(r.fetchImpl).toHaveBeenCalledTimes(1); // and it is not read a second time
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rejected read does not poison the day for the process', async () => {
    // `load` answers rather than throwing, so this is the path that only opens once a
    // caller may stop waiting: nobody is left awaiting the flight to clean it up. Reached
    // here by a `load` that does throw — its own warning fails once.
    let clock = 1_000;
    let warned = 0;
    const warn = () => {
      warned += 1;
      if (warned === 1) throw new Error('log down');
    };
    const responses = [() => Promise.reject(new Error('boom')), () => Promise.resolve(ok({ source: { kind: 'poem' } }))];
    const fetchImpl = vi.fn(async () => responses[Math.min(fetchImpl.mock.calls.length - 1, 1)]());
    const r = createDaySourceReader({
      apiBaseUrl: 'https://api.whippin.ai',
      log: { warn, info: () => {} } as unknown as Log,
      now: () => clock,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await r.get('fr', '2026-09-03')).toBeNull();
    expect(warned).toBe(2); // the one that threw, then the flight's own
    clock += 6 * 60_000;
    expect(await r.get('fr', '2026-09-03')).toEqual({ kind: 'poem' });
  });
});

describe('the whole answer, waited for (the reminder)', () => {
  it('says whether the day is published, and null for a read that failed', async () => {
    const published = reader([() => ok({ lang: 'fr', source: { kind: 'music' } })]);
    expect(await published.reader.read('fr', '2026-09-04')).toEqual({ published: true, source: { kind: 'music' }, secrets: null });
    const bare = reader([() => ok({ lang: 'fr' })]);
    expect(await bare.reader.read('fr', '2026-09-04')).toEqual({ published: true, source: null, secrets: null });
    const missing = reader([() => new Response('', { status: 404 })]);
    expect(await missing.reader.read('fr', '2026-09-04')).toEqual({ published: false, source: null, secrets: null });
    const down = reader([() => new Response('', { status: 503 })]);
    expect(await down.reader.read('fr', '2026-09-04')).toBeNull();
    // And it shares the cache with `get`: one read serves both.
    expect(await published.reader.get('fr', '2026-09-04')).toEqual({ kind: 'music' });
    expect(published.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("the sentence, held for the web's spoiler guard and never for a prompt (v22)", () => {
  it('reads the words and the hidden ones out of the same parse', async () => {
    const puzzle = {
      lang: 'fr',
      words: ['tu', "t'attends", 'à', 'rien,'],
      holes: [{ pos: 1, secret: { word: 'attends', slug: 'attends' }, prefix: "t'" }],
      source: { kind: 'music' },
    };
    const { reader: r } = reader([() => ok(puzzle)]);
    const read = await r.read('fr', '2026-09-04');
    expect(read?.secrets).toEqual({ words: ['tu', 't', 'attends', 'a', 'rien'], hidden: [false, false, true, false, false] });
    // The prompt's half is unchanged: the source alone.
    expect(await r.get('fr', '2026-09-04')).toEqual({ kind: 'music' });
  });
});

describe('a published day is re-asked by its ETag (v22)', () => {
  it('keeps the source through a re-ask that fails, and closes the web meanwhile', async () => {
    let at = 1_000;
    const { reader: r } = reader([() => ok({ source: { kind: 'music', author: 'Bertrand Belin' } }), () => new Response('', { status: 503 })], () => at);
    expect(await r.get('fr', '2026-09-04')).toEqual({ kind: 'music', author: 'Bertrand Belin' });
    at += 6 * 60_000;
    expect(await r.read('fr', '2026-09-04')).toBeNull(); // the guard cannot be trusted: the web closes
    expect(await r.get('fr', '2026-09-04')).toEqual({ kind: 'music', author: 'Bertrand Belin' }); // the rule still holds
  });

  it('keeps what it holds on a 304, and takes a corrected sentence on a 200', async () => {
    let at = 1_000;
    const v1 = { words: ['je', 'marche', 'seul', 'dans'], holes: [{ pos: 2, secret: { word: 'seul' } }] };
    const v2 = { words: ['tu', 'cours', 'vite', 'ici'], holes: [{ pos: 1, secret: { word: 'cours' } }] };
    const tagged = (body: unknown, etag: string) => new Response(JSON.stringify(body), { status: 200, headers: { etag } });
    const { reader: r, fetchImpl } = reader([() => tagged(v1, '"r1"'), () => new Response(null, { status: 304 }), () => tagged(v2, '"r2"')], () => at);
    expect((await r.read('fr', '2026-09-04'))?.secrets?.words).toEqual(['je', 'marche', 'seul', 'dans']);
    at += 6 * 60_000;
    expect((await r.read('fr', '2026-09-04'))?.secrets?.words).toEqual(['je', 'marche', 'seul', 'dans']);
    const asked = (fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect((asked.headers as Record<string, string>)['if-none-match']).toBe('"r1"');
    at += 6 * 60_000;
    expect((await r.read('fr', '2026-09-04'))?.secrets?.words).toEqual(['tu', 'cours', 'vite', 'ici']);
  });
});
