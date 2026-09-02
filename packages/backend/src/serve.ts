// Local backend harness (issue #17): runs the SAME `createHandler` as the deployed
// Lambda (#2), only swapping the S3 store for a local filesystem store. The day
// resolution (22:00 ET, DST-correct), 404-no-puzzle, CORS, and `Puzzle` response
// shape are therefore identical to production — this is a thin Function-URL ⇄ HTTP
// adapter, not a second backend.
//
// Run it with `pnpm backend:dev` (or `pnpm --filter @whippin/backend serve:local`)
// and point the front at it via VITE_API_BASE_URL (e.g. http://localhost:8787).
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createHandler } from './handler';
import { fsStore } from './fsStore';
import { defaultLocalStoreRoot } from './layout';
import { memoryDeviceStore } from './memoryDeviceStore';
import { memoryFriendStore } from './memoryFriendStore';
import { memoryHistoryStore } from './memoryHistoryStore';
import { memoryLinkStore } from './memoryLinkStore';
import { memoryProfileStore } from './memoryProfileStore';
import { memoryRoundStore } from './memoryRoundStore';
import { memoryScoreStore } from './memoryScoreStore';
import type { FnUrlEvent } from './respond';
import { consoleMailer } from './mailer';
import { localTurnstileVerifier } from './turnstile';

const PORT = Number(process.env.PORT ?? 8787);
const STORE_ROOT = process.env.PUZZLE_STORE ?? defaultLocalStoreRoot();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';
// The per-ADDRESS submission allowance, turned OFF here and explicitly so — the same kind
// of stated local-only choice as the accept-all Turnstile verifier below.
//
// In production the cap bounds how many players ONE address may record in a day: real
// anti-abuse, where addresses differ. Locally every client is 127.0.0.1 by construction,
// so it bounds nothing — it just makes the daily loop untestable after five identities,
// and does it SILENTLY: the sixth submission is a 429, which is a 4xx, which the client
// reads as a VERDICT and never retries. From then on that day publishes nothing, on every
// device, forever, with no message anywhere (user-reported 2026-08-20).
const LOCAL_SUBMISSION_LIMIT = Number.POSITIVE_INFINITY;
const LOCAL_IP_HMAC_SECRET = randomBytes(32).toString('hex');

const localScoreStore = memoryScoreStore(() => new Date(), LOCAL_SUBMISSION_LIMIT);
// The identity every authenticated route resolves its caller through (#216). In memory
// like the rest: restarting the local server signs every local device out, which is exactly
// what a wiped table does.
const localDeviceStore = memoryDeviceStore();
// One instance of each store the LINK route also acts on (#204): a verified link moves the
// day's round and score rows, credits solved days and rewrites friend edges, so it has to
// hold the very same objects the other routes read.
const localFriendStore = memoryFriendStore((publicId) => localDeviceStore.accountExists(publicId));
const localRoundStore = memoryRoundStore();
const localHistoryStore = memoryHistoryStore();
// `live` is the DEVICE store's answer (#204): a deleted account must stop dressing board
// rows and invite previews, and two in-memory copies of "does this account exist" would
// drift exactly where that matters.
const localProfileStore = memoryProfileStore((publicId) =>
  localDeviceStore.accountExists(publicId),
);

const handler = createHandler({
  store: fsStore(STORE_ROOT),
  // No siteOrigin: the preview pages (`/s/<token>`, `/i/<publicId>`) fall back to the
  // REQUEST's Host, and the dev server proxies those paths here WITHOUT rewriting it
  // (web/vite.config.ts), so a page served through the proxy addresses the app rather
  // than this server. Reached directly on :8787 it addresses :8787, which is honest.
  allowedOrigin: ALLOWED_ORIGIN,
  // Read-only since #203 — the population is written by the round route below.
  scores: { scoreStore: localScoreStore },
  profiles: localProfileStore,
  friends: localFriendStore,
  // The ONE store every authenticated route resolves its caller through (#216).
  deviceStore: localDeviceStore,
  devices: {
    // The bootstrap is Turnstile-gated (#216) by the accept-all local verifier, exactly
    // like a round start.
    turnstile: localTurnstileVerifier,
    allowSourceIp: true,
  },
  rounds: {
    roundStore: localRoundStore,
    // A finished round records its own score row (#203), off the same in-memory store the
    // /scores read serves from.
    scoreStore: localScoreStore,
    ipHmacSecret: LOCAL_IP_HMAC_SECRET,
    // ROUND START is gated in both modes (#202/#203) by the accept-all local verifier.
    // Explicitly local-only: the production entrypoint always wires real Siteverify.
    turnstile: localTurnstileVerifier,
    // A confirmed solve credits the streak's day (#211); `/history` reads it back. In
    // memory here, so a restart resets the streak with the rounds it is a cache of.
    history: localHistoryStore,
    allowSourceIp: true,
  },
  // Email account linking (#204). The code is PRINTED to this server's log rather than
  // mailed — `backend:dev` has no verified domain, and a link flow you cannot complete
  // locally is a link flow nobody tests. Explicitly local-only, exactly like the accept-all
  // Turnstile verifier beside it.
  link: {
    links: memoryLinkStore({ devices: localDeviceStore, profiles: localProfileStore }),
    friends: localFriendStore,
    rounds: localRoundStore,
    scores: localScoreStore,
    history: localHistoryStore,
    mailer: consoleMailer,
    turnstile: localTurnstileVerifier,
    ipHmacSecret: LOCAL_IP_HMAC_SECRET,
    allowSourceIp: true,
  },
});

// Adapt a Node http request into the minimal Lambda Function URL event the handler reads.
async function toEvent(req: IncomingMessage): Promise<FnUrlEvent> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
  return {
    rawPath: url.pathname,
    queryStringParameters: query,
    requestContext: { http: { method: req.method, sourceIp: req.socket.remoteAddress } },
    headers,
    body,
  };
}

const server = createServer(async (req, res) => {
  try {
    const result = await handler(await toEvent(req));
    res.writeHead(result.statusCode, result.headers);
    // Binary responses (the OG PNG) come back base64-encoded, just like a Function URL.
    res.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body);
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
  console.log(`[backend]   scores + devices: in-memory; Turnstile accept-all (local only)`);
  console.log(`[backend]   GET /?lang=<xx>&date=<YYYY-MM-DD>[&mode=word]  GET /scores?lang=&date=&mode=`);
  console.log(`[backend]   GET /profile?id=<publicId>  POST /profile  POST /friends`);
  console.log(`[backend]   GET|POST /board?lang=&date=&mode=[&id=]  POST /round?lang=&date=&mode=`);
  console.log(`[backend]   POST /history?lang=&mode=[&month=YYYY-MM]  POST /devices  POST /link`);
  console.log(`[backend]   GET /today  GET /s/<token>  GET /og/<token>.png`);
  console.log(`[backend] point the front at it: VITE_API_BASE_URL=http://localhost:${PORT}`);
});
