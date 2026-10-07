import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { GROUP_SEGMENT, SHARE_SEGMENT } from '@whippin/shared';

// ── Per-IP rate limits at the edge (WAF) ─────────────────────────────────────
// The API Lambda's reserved concurrency is the CEILING on what it can cost; these limits
// stop ONE address from spending it, so the ceiling can sit high enough for a crowd of
// players. Each distribution wears its own web ACL, because each sees a different address:
// the web distribution sees the viewer, while the API distribution sees the web
// distribution's edge servers for every share page, card and invite preview it fetches on
// a cache miss, each carrying many viewers' misses. So the render paths are limited where the
// VIEWER is seen (the web stack) and nowhere else, and the API's one limit, on every request,
// stays far above what those edge servers pass on.

// What the Lambda RENDERS for anyone, unauthenticated: the share page, its card, the
// group invite preview (and its card, under /og/). Every distinct token misses the CDN.
const RENDER_PATH_PREFIXES = [`/${SHARE_SEGMENT}/`, '/og/', `/${GROUP_SEGMENT}/`];

// Requests per address per five minutes. RENDER: a person opens a handful of shares and
// invites, and a link-preview crawler fetches each card once a year (they are cached), so 1/s
// sustained is far past any honest use. ALL: one player guesses at most once a second
// (ROUND_WRITE_MIN_MS) and reads a board at most every 10 s, ~350 requests in five minutes;
// 3000 leaves room for a school or an office behind one address.
const RENDER_LIMIT = 300;
const ALL_LIMIT = 3000;

interface RateLimit {
  name: string;
  limit: number;
  // Only requests whose path starts with one of these count; every request when omitted.
  pathPrefixes?: string[];
}

export const RENDER_RATE_LIMIT: RateLimit = {
  name: 'PerIpRender',
  limit: RENDER_LIMIT,
  pathPrefixes: RENDER_PATH_PREFIXES,
};
export const ALL_RATE_LIMIT: RateLimit = { name: 'PerIpAll', limit: ALL_LIMIT };

const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true,
  metricName,
  sampledRequestsEnabled: true,
});

const startsWith = (prefix: string): wafv2.CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint: 'STARTS_WITH',
    searchString: prefix,
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
});

const pathScope = (prefixes: string[]): wafv2.CfnWebACL.StatementProperty =>
  prefixes.length === 1
    ? startsWith(prefixes[0])
    : { orStatement: { statements: prefixes.map(startsWith) } };

// A CLOUDFRONT-scoped web ACL (it must live in us-east-1, as every stack here does) that
// allows everything except an address over one of `limits`. A blocked request is a 429 with
// no body and no CORS headers, so a cross-origin fetch of it rejects and the clients take
// their transport-failure path: an unknown outcome, read again, never a verdict.
export function rateLimitedWebAcl(
  scope: Construct,
  id: string,
  limits: RateLimit[],
): wafv2.CfnWebACL {
  return new wafv2.CfnWebACL(scope, id, {
    scope: 'CLOUDFRONT',
    defaultAction: { allow: {} },
    visibilityConfig: visibility(id),
    rules: limits.map(({ name, limit, pathPrefixes }, priority) => ({
      name,
      priority,
      action: { block: { customResponse: { responseCode: 429 } } },
      statement: {
        rateBasedStatement: {
          limit,
          evaluationWindowSec: 300,
          aggregateKeyType: 'IP',
          scopeDownStatement: pathPrefixes ? pathScope(pathPrefixes) : undefined,
        },
      },
      visibilityConfig: visibility(`${id}${name}`),
    })),
  });
}
