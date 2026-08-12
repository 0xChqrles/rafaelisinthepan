import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Lambda's BUFFERED response cap. The runtime posts the whole {statusCode, headers, body}
// envelope back as JSON and refuses anything larger with a 413 ("Exceeded maximum allowed
// payload size"), which reaches the caller as an opaque CloudFront 502 — the handler never
// runs its own error path, so nothing but the runtime log explains it.
//
// The number to compare against is the ENVELOPE, not the body: the body is escaped into a
// JSON string, so every `"` costs a second byte. A puzzle's rank maps are almost all quoted
// keys, which inflates them ~18% — a 5.85 MB payload becomes a 6.9 MB envelope. Measuring
// the body alone would call that safe and still 502.
export const LAMBDA_MAX_RESPONSE_BYTES = 6_291_556;

// `envelopeBytes` models the runtime's payload as JSON.stringify(result), which is a close
// FLOOR rather than the exact number — the runtime wraps it in framing this handler never
// sees. So the guard holds a few KB back instead of comparing against the cap itself: a
// payload landing inside that margin would pass the check and still 413, which is precisely
// the failure the guard exists to convert into a named error. Today's compressed envelope is
// ~942 KB against a 6.29 MB cap, so the reserve costs nothing real.
const ENVELOPE_RESERVE_BYTES = 8_192;
export const ENVELOPE_BUDGET_BYTES = LAMBDA_MAX_RESPONSE_BYTES - ENVELOPE_RESERVE_BYTES;

// Below this, gzip's header + base64's 4/3 expansion cost more than the compression saves.
// CloudFront uses the same 1 KB floor for its own automatic compression.
const MIN_COMPRESS_BYTES = 1_024;

// Level 6 (zlib's default) on a real 5.9 MB puzzle: ~76 ms for a 1.12 MB envelope. Level 9
// spends 290 ms to save another 12 KB, level 1 saves 54 ms and costs 208 KB — neither trade
// is worth it against a request that already spends >1 s fetching and parsing from S3.
const GZIP_LEVEL = 6;

// Brotli is offered FIRST because on this payload it beats gzip in both dimensions at once:
// 706 KB in 57 ms against gzip level 6's 837 KB in 75 ms. It is also what CloudFront picks
// for any viewer advertising it, so a gzip-only origin would hand today's browsers MORE
// bytes than they get from the CDN's own compression — a regression disguised as a fix.
// Quality 5 is the knee: q9 saves a further 78 KB but costs 150 ms.
const BROTLI_QUALITY = 5;

// Minimal shape of an AWS Lambda Function URL request/response (API Gateway HTTP API
// payload v2.0). Only the fields the handler reads/writes are modelled, so the handler
// stays trivially testable without pulling in @types/aws-lambda.
export interface FnUrlEvent {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
}

export interface FnUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  // Binary payloads (the OG PNG) are base64-encoded; Function URLs decode when this is set,
  // and the local serve.ts adapter does the same.
  isBase64Encoded?: boolean;
}

// CORS headers so the web origin can read responses. `origin` is configured (set to
// the web origin in prod; "*" by default). `Vary: Origin` keeps the CDN honest when a
// specific origin is echoed.
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export function json(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): FnUrlResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  };
}

// Add a field to a Vary header without duplicating what is already listed. CORS already
// sets `Vary: Origin`, and a plain overwrite there would let a shared cache ignore the
// origin echo.
function withVary(existing: string | undefined, field: string): string {
  const fields = (existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fields.some((entry) => entry.toLowerCase() === field.toLowerCase())) {
    return fields.join(', ');
  }
  return [...fields, field].join(', ');
}

type ContentEncoding = 'br' | 'gzip';

// Pick the best encoding the client actually accepts, or null for none.
//
// Both codings must be handled, not just gzip: CloudFront normalizes Accept-Encoding down to
// the br/gzip values the viewer offered before forwarding it here, so a br-capable viewer can
// arrive as `br` alone — and a gzip-only origin would then have to answer that request
// uncompressed, which for a puzzle means no answer at all.
//
// A `q=0` is honoured as the REFUSAL it is rather than read as mere presence of the token,
// and a refusal outranks a wildcard: per RFC 9110 §12.5.3 the most specific match wins, so
// `br;q=0, *` must not be answered in brotli. Relative q ORDERING is deliberately not
// implemented — `gzip;q=1.0, br;q=0.1` still picks brotli. CloudFront strips q-values when
// it normalizes the header, so ordering never survives to this origin in production; only
// the outright refusal is worth honouring, and getting THAT wrong ships a body the client
// cannot decode.
export function negotiateEncoding(header: string | undefined): ContentEncoding | null {
  if (!header) return null;
  const offered = new Set<string>();
  const refused = new Set<string>();
  for (const part of header.split(',')) {
    const [rawToken, ...params] = part.split(';');
    const token = rawToken.trim().toLowerCase();
    if (token !== 'br' && token !== 'gzip' && token !== '*') continue;
    const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) {
      refused.add(token);
      continue;
    }
    offered.add(token);
  }
  const acceptable = (coding: ContentEncoding) =>
    !refused.has(coding) && (offered.has(coding) || offered.has('*'));
  if (acceptable('br')) return 'br';
  if (acceptable('gzip')) return 'gzip';
  return null;
}

function compress(payload: string, encoding: ContentEncoding): Buffer {
  if (encoding === 'gzip') return gzipSync(payload, { level: GZIP_LEVEL });
  return brotliCompressSync(payload, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      // Declaring the input size is the documented way to let brotli size its heuristics.
      // Measured on a real 5.85 MB puzzle it changes NOTHING (706,379 bytes either way, same
      // time) — kept because it is free and correct, not because it buys anything here.
      [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(payload),
    },
  });
}

// The serialized size of what the Lambda runtime will actually post back, so a payload can
// be checked against LAMBDA_MAX_RESPONSE_BYTES before the runtime rejects it unattributably.
export function envelopeBytes(result: FnUrlResult): number {
  return Buffer.byteLength(JSON.stringify(result));
}

// JSON compressed with the best encoding the client accepts. The puzzle payload is megabytes
// of rank maps (#104's alias expansion roughly tripled them), and this is what keeps it under
// the runtime's envelope cap.
//
// CloudFront already compresses these responses for viewers, so this is NOT a bandwidth win
// for players — it moves the compression to the only place that can lift the origin's own
// ceiling. It does remove a real future cliff though: CloudFront declines to compress any
// object above 10 MB, so a puzzle that grew past that would have been served to phones raw.
//
// The cache policy sets enableAcceptEncodingGzip/Brotli, which per AWS "includes the
// Accept-Encoding header in the cache key and in origin requests automatically" — so the
// header does reach this handler, variants cache separately upstream, and CloudFront passes
// an already-encoded response straight through without recompressing it.
export function jsonCompressed(
  statusCode: number,
  body: unknown,
  acceptEncoding: string | undefined,
  headers: Record<string, string> = {},
): FnUrlResult {
  const payload = JSON.stringify(body);
  const base: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  };
  // Carried whether or not THIS response was compressed: the representation still depends
  // on the request header, so a cache that stored the plain body must not replay it to a
  // client whose gzip variant differs (and vice versa).
  const merged = { ...base, Vary: withVary(base.Vary, 'Accept-Encoding') };

  const encoding = negotiateEncoding(acceptEncoding);
  if (encoding === null || Buffer.byteLength(payload) < MIN_COMPRESS_BYTES) {
    return { statusCode, headers: merged, body: payload };
  }
  return {
    statusCode,
    headers: { ...merged, 'Content-Encoding': encoding },
    body: compress(payload, encoding).toString('base64'),
    isBase64Encoded: true,
  };
}

export function errorResponse(
  statusCode: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): FnUrlResult {
  return json(statusCode, { error, message, ...extra }, headers);
}

// An HTML page (the share-card OG page).
export function html(statusCode: number, body: string, headers: Record<string, string> = {}): FnUrlResult {
  return { statusCode, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers }, body };
}

// A permanent redirect (a superseded share token pointing at the day it named).
export function redirect(
  statusCode: number,
  location: string,
  headers: Record<string, string> = {},
): FnUrlResult {
  return { statusCode, headers: { Location: location, ...headers }, body: '' };
}

// A binary PNG (the share-card OG image), base64-encoded for the Function URL / adapter.
export function png(statusCode: number, buffer: Buffer, headers: Record<string, string> = {}): FnUrlResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'image/png', ...headers },
    body: buffer.toString('base64'),
    isBase64Encoded: true,
  };
}
