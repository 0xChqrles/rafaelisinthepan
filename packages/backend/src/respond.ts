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

// A binary PNG (the share-card OG image), base64-encoded for the Function URL / adapter.
export function png(statusCode: number, buffer: Buffer, headers: Record<string, string> = {}): FnUrlResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'image/png', ...headers },
    body: buffer.toString('base64'),
    isBase64Encoded: true,
  };
}
