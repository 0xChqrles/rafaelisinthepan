import { describe, expect, it, vi } from 'vitest';
import { createLog } from '../log';
import { createDaySourceReader, revealsSource, sourceContext } from './daySource';

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
    expect(await r.reader.get('fr', 20700, '2026-09-03')).toEqual({
      kind: 'music',
      author: 'Bertrand Belin',
      work: 'Oiseau',
    });
    await r.reader.get('fr', 20700, '2026-09-03');
    await r.reader.get('fr', 20700, '2026-09-03');
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
      r.reader.get('fr', 20700, '2026-09-03'),
      r.reader.get('fr', 20700, '2026-09-03'),
      r.reader.get('fr', 20700, '2026-09-03'),
    ]);
    release(ok({ source: { kind: 'book' } }));
    expect(await all).toEqual([{ kind: 'book' }, { kind: 'book' }, { kind: 'book' }]);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by DAY and by LANGUAGE — two dailies are two sources', async () => {
    const r = reader([() => ok({ source: { kind: 'music' } }), () => ok({ source: { kind: 'poem' } })]);
    expect(await r.reader.get('fr', 20700, '2026-09-03')).toEqual({ kind: 'music' });
    expect(await r.reader.get('en', 20700, '2026-09-03')).toEqual({ kind: 'poem' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(2);
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
    expect(await r.reader.get('fr', 20700, '2026-09-03')).toEqual({
      kind: 'music',
      author: 'Bertrand Belin',
      work: 'Oiseau',
    });
  });

  it('an unpublished day is an ANSWER and is never re-read; a failure is retried later', async () => {
    const missing = reader([() => new Response('', { status: 404 })]);
    expect(await missing.reader.get('fr', 20700, '2026-09-03')).toBeNull();
    await missing.reader.get('fr', 20700, '2026-09-03');
    expect(missing.fetchImpl).toHaveBeenCalledTimes(1); // settled: no puzzle that day

    let clock = 1_000;
    const down = reader(
      [() => new Response('', { status: 503 }), () => ok({ source: { kind: 'music' } })],
      () => clock,
    );
    expect(await down.reader.get('fr', 20700, '2026-09-03')).toBeNull();
    await down.reader.get('fr', 20700, '2026-09-03');
    expect(down.fetchImpl).toHaveBeenCalledTimes(1); // not re-read at the rate the group talks
    clock += 6 * 60_000;
    expect(await down.reader.get('fr', 20700, '2026-09-03')).toEqual({ kind: 'music' });
  });

  it('a puzzle with no source, an unreachable API and a broken body all read as NOTHING', async () => {
    const none = reader([() => ok({ lang: 'fr', words: [] })]);
    expect(await none.reader.get('fr', 20700, '2026-09-03')).toBeNull();
    const dead = reader([
      () => {
        throw new Error('ECONNREFUSED');
      },
    ]);
    expect(await dead.reader.get('fr', 20700, '2026-09-03')).toBeNull();
    const junk = reader([() => new Response('<html>', { status: 200 })]);
    expect(await junk.reader.get('fr', 20700, '2026-09-03')).toBeNull();
  });

  it('a body that PARSES but is not an object is an answer, not a thrown error', async () => {
    // `null`, `[]` and a bare string are all valid JSON, so the parse SUCCEEDS — and
    // reading `.source` off `null` then throws. Outside the try that TypeError escaped the
    // whole caching path, so a backend answering `200 null` was re-read at the rate the
    // group talks. Read safely it is simply a day with no source: settled, quiet, one read.
    for (const body of ['null', '[]', '"whippin"']) {
      const r = reader([() => new Response(body, { status: 200 })]);
      expect(await r.reader.get('fr', 20700, '2026-09-03')).toBeNull();
      await r.reader.get('fr', 20700, '2026-09-03');
      expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the KIND may be said; the author and the work may not', () => {
  it('carries the whole source, and the rule that only the kind is sayable', () => {
    const text = sourceContext({ kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' });
    // The model KNOWS all of it — it has to, to know what it is holding back, and to say
    // so after the day is over.
    expect(text).toContain('kind: music');
    expect(text).toContain('author: Bertrand Belin');
    expect(text).toContain('work: Oiseau');
    // The kind is colour and narrows nothing; the title is one search from the sentence.
    expect(text).toContain('say the KIND freely');
    expect(text).toMatch(/NOT name the author or the work/);
    // The sneaky leak is agreeing with somebody else's guess, so it is named.
    expect(text).toMatch(/confirm or deny/);
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(sourceContext(null)).toBe('');
    expect(sourceContext({})).toBe('');
  });

  it('states only the fields the day actually carries — every one is optional (#5)', () => {
    // The FACTS are what varies; the rule below them always names the author and the work,
    // because it forbids them whether or not this day has any.
    const facts = (s: Parameters<typeof sourceContext>[0]) =>
      /\(([^)]*)\)/.exec(sourceContext(s))?.[1] ?? '';
    expect(facts({ kind: 'quote' })).toBe('kind: quote');
    expect(facts({ author: 'Victor Hugo' })).toBe('author: Victor Hugo');
    expect(facts({ kind: 'book', work: 'Les Misérables' })).toBe('kind: book, work: Les Misérables');
  });
});

describe('a reply that spells the source is caught (PR-247 review)', () => {
  it('matches the author whole and a multi-word title, through case, accents and spacing', () => {
    const belin = { kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' };
    expect(revealsSource("c'est du Bertrand Belin", belin)).toBe(true);
    expect(revealsSource('BERTRAND-BELIN', belin)).toBe(true);
    expect(revealsSource("c'est du Belin", belin)).toBe(false); // a fragment is the prompt's job
    expect(revealsSource('un oiseau sur la branche', belin)).toBe(false); // one-word title: a common noun
    const hugo = { kind: 'book', author: 'Victor Hugo', work: 'Les Misérables' };
    expect(revealsSource('ça sent les miserables', hugo)).toBe(true);
    expect(revealsSource('Les Misérables, non ?', hugo)).toBe(true);
    expect(revealsSource('victorhugo', hugo)).toBe(true);
    expect(revealsSource('hugo', hugo)).toBe(false);
    expect(revealsSource('rien à voir', null)).toBe(false);
    expect(revealsSource('rien à voir', { kind: 'music' })).toBe(false);
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
      const first = r.reader.get('fr', 20700, '2026-09-03');
      await vi.advanceTimersByTimeAsync(1_600);
      expect(await first).toBeNull();

      // The read was never abandoned: it lands, and the group's next message has it.
      release(ok({ source: { kind: 'music', author: 'Bertrand Belin', work: 'Oiseau' } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(await r.reader.get('fr', 20700, '2026-09-03')).toEqual({
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
    // caller may stop waiting: nobody is left awaiting the flight to clean it up.
    let clock = 1_000;
    const r = reader(
      [
        () => Promise.reject(new Error('boom')),
        () => ok({ source: { kind: 'poem' } }),
      ],
      () => clock,
    );
    expect(await r.reader.get('fr', 20700, '2026-09-03')).toBeNull();
    clock += 6 * 60_000;
    expect(await r.reader.get('fr', 20700, '2026-09-03')).toEqual({ kind: 'poem' });
  });
});
