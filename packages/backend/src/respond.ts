import { gzipSync } from 'node:zlib';

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

// Below this, gzip's header + base64's 4/3 expansion cost more than the compression saves.
// CloudFront uses the same 1 KB floor for its own automatic compression.
const MIN_COMPRESS_BYTES = 1_024;

// Level 6 (zlib's default) on a real 5.9 MB puzzle: ~76 ms for a 1.12 MB envelope. Level 9
// spends 290 ms to save another 12 KB, level 1 saves 54 ms and costs 208 KB — neither trade
// is worth it against a request that already spends >1 s fetching and parsing from S3.
const GZIP_LEVEL = 6;

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

export interface ErrorBody {
  error: string; // machine-readable code, e.g. "not_found"
  message: string; // human-readable detail
  [extra: string]: unknown;
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

// Does the client accept gzip? Parses the q-value so an explicit `gzip;q=0` (a refusal) is
// honoured rather than read as mere presence of the token.
export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [rawToken, ...params] = part.split(';');
    const token = rawToken.trim().toLowerCase();
    if (token !== 'gzip' && token !== '*') continue;
    const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

// The serialized size of what the Lambda runtime will actually post back, so a payload can
// be checked against LAMBDA_MAX_RESPONSE_BYTES before the runtime rejects it unattributably.
export function envelopeBytes(result: FnUrlResult): number {
  return Buffer.byteLength(JSON.stringify(result));
}

// JSON that is gzipped when the client accepts it. The puzzle payload is megabytes of rank
// maps (#104's alias expansion roughly tripled them), so this is what keeps it under the
// runtime's envelope cap — and it cuts the bytes on the wire ~7x for every player besides.
//
// CloudFront's cache policy sets enableAcceptEncodingGzip, so it normalizes Accept-Encoding
// into the cache key AND forwards it here; the compressed and plain variants therefore cache
// separately upstream, and `Vary: Accept-Encoding` keeps every cache below it honest too.
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

  if (!acceptsGzip(acceptEncoding) || Buffer.byteLength(payload) < MIN_COMPRESS_BYTES) {
    return { statusCode, headers: merged, body: payload };
  }
  return {
    statusCode,
    headers: { ...merged, 'Content-Encoding': 'gzip' },
    body: gzipSync(payload, { level: GZIP_LEVEL }).toString('base64'),
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
