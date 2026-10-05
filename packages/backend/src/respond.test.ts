// CONTRACT: content-encoding negotiation. A puzzle response only fits under the Lambda
// runtime's envelope cap when it is compressed, so picking the coding is load-bearing —
// and picking one the client did NOT accept ships a body it cannot decode. These cases run
// against the exported function directly: routing them through the handler would mean
// rebuilding a 130k-key puzzle per assertion, which is why the wildcard cases below went
// unnoticed until they were tested here.

import { describe, it, expect } from 'vitest';
import {
  ENVELOPE_BUDGET_BYTES,
  LAMBDA_MAX_RESPONSE_BYTES,
  envelopeBytes,
  negotiateEncoding,
} from './respond';

describe('negotiateEncoding — best coding the client actually accepts', () => {
  const cases: Array<[string | undefined, 'br' | 'gzip' | null, string]> = [
    // What real viewers send, and what CloudFront normalizes them down to.
    ['br, gzip, deflate', 'br', 'a browser: brotli wins'],
    ['gzip, deflate, br, zstd', 'br', 'an unknown coding in the list changes nothing'],
    ['br,gzip', 'br', "CloudFront's normalized form"],
    ['br', 'br', 'br alone — CloudFront can produce this'],
    ['gzip', 'gzip', 'gzip alone'],
    ['GZIP', 'gzip', 'tokens are case-insensitive'],
    [undefined, null, 'no header at all'],
    ['', null, 'an empty header is not an offer'],
    ['identity', null, 'identity only'],
    ['deflate', null, 'nothing we implement'],

    // q=0 is a refusal, not an offer.
    ['br;q=0, gzip', 'gzip', 'brotli refused, gzip taken'],
    ['gzip;q=0, br', 'br', 'gzip refused, brotli taken'],
    ['br;q=0, gzip;q=0, identity', null, 'both refused'],
    ['gzip;q=0.0', null, 'q=0.0 is still zero'],
    ['gzip; q=0', null, 'whitespace around the q parameter'],
    ['gzip;q=0.001', 'gzip', 'a tiny q is still an offer'],

    // The wildcard: it may STAND IN for a coding, but it may never override an explicit
    // refusal — RFC 9110 §12.5.3 matches the most specific token first.
    ['*', 'br', 'a bare wildcard accepts anything'],
    ['br;q=0, *', 'gzip', 'wildcard cannot resurrect refused brotli'],
    ['br;q=0, gzip;q=0, *', null, 'wildcard cannot resurrect either refusal'],
    ['gzip;q=0, *', 'br', 'wildcard still covers the coding that was NOT refused'],
    ['*;q=0, gzip', 'gzip', 'a refused wildcard leaves the explicit offer standing'],
    ['*;q=0', null, 'a refused wildcard offers nothing'],
  ];

  for (const [header, expected, why] of cases) {
    it(`${JSON.stringify(header)} -> ${expected} (${why})`, () => {
      expect(negotiateEncoding(header)).toBe(expected);
    });
  }
});

describe('envelope budget — the guard keeps slack against an approximated size', () => {
  it('measures the serialized envelope, not just the body', () => {
    const result = { statusCode: 200, headers: { A: 'b' }, body: '"' };
    // The body is escaped INTO the envelope's JSON string, so a quote costs two bytes there.
    expect(envelopeBytes(result)).toBe(Buffer.byteLength(JSON.stringify(result)));
    expect(envelopeBytes(result)).toBeGreaterThan(Buffer.byteLength(result.body));
  });

  it('budgets below the runtime cap rather than exactly at it', () => {
    // envelopeBytes models the runtime payload; the runtime adds framing this code never
    // sees, so a payload measured just under the cap could still be refused.
    expect(ENVELOPE_BUDGET_BYTES).toBeLessThan(LAMBDA_MAX_RESPONSE_BYTES);
  });
});
