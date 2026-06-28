// Local backend harness (issue #17): runs the SAME `createHandler` as the deployed
// Lambda (#2), only swapping the S3 store for a local filesystem store. The day
// resolution (22:00 ET, DST-correct), 404-no-puzzle, CORS, and `Puzzle` response
// shape are therefore identical to production — this is a thin Function-URL ⇄ HTTP
// adapter, not a second backend.
//
// Run it with `pnpm backend:dev` (or `pnpm --filter @rafaelisinthepan/backend serve:local`)
// and point the front at it via VITE_API_BASE_URL (e.g. http://localhost:8787).
import { createServer, type IncomingMessage } from 'node:http';
import { createHandler } from './handler';
import { fsStore } from './fsStore';
import { defaultLocalStoreRoot } from './layout';
import type { FnUrlEvent } from './respond';

const PORT = Number(process.env.PORT ?? 8787);
const STORE_ROOT = process.env.PUZZLE_STORE ?? defaultLocalStoreRoot();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';

const handler = createHandler({
  store: fsStore(STORE_ROOT),
  allowedOrigin: ALLOWED_ORIGIN,
});

// Adapt a Node http request into the minimal Lambda Function URL event the handler reads.
function toEvent(req: IncomingMessage): FnUrlEvent {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return {
    rawPath: url.pathname,
    queryStringParameters: query,
    requestContext: { http: { method: req.method } },
    headers,
  };
}

const server = createServer(async (req, res) => {
  try {
    const result = await handler(toEvent(req));
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
  } catch (err) {
    // The handler already maps its own errors to JSON 500s; this only guards the adapter.
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal_error', message: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[backend] local puzzle server on http://localhost:${PORT}`);
  console.log(`[backend]   store:  ${STORE_ROOT}`);
  console.log(`[backend]   origin: ${ALLOWED_ORIGIN}`);
  console.log(`[backend]   GET /?lang=<xx>  GET /today`);
  console.log(`[backend] point the front at it: VITE_API_BASE_URL=http://localhost:${PORT}`);
});
