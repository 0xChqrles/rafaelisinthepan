import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { VIEWER_IP_HEADER } from '@whippin/shared';
import { BackendStack } from './backend-stack';

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const TURNSTILE_PARAMETER = '/test/turnstile-secret';
const IP_HMAC_PARAMETER = '/test/ip-hmac-secret';

function backendTemplate(): Template {
  const app = new App();
  const stack = new BackendStack(app, 'TestBackendStack', {
    env: { account: ACCOUNT, region: REGION },
    turnstileSecretParameter: TURNSTILE_PARAMETER,
    ipHmacSecretParameter: IP_HMAC_PARAMETER,
  });
  return Template.fromStack(stack);
}

const template = backendTemplate();

describe('score production boundary (#169)', () => {
  it('passes only parameter names to Lambda and grants one exact GetParameters read', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    expect(functions).toHaveLength(1);
    const variables = functions[0].Properties.Environment.Variables as Record<string, unknown>;
    expect(variables).toMatchObject({
      TURNSTILE_SECRET_PARAMETER: TURNSTILE_PARAMETER,
      IP_HMAC_SECRET_PARAMETER: IP_HMAC_PARAMETER,
    });
    expect(variables).not.toHaveProperty('TURNSTILE_SECRET');
    expect(variables).not.toHaveProperty('IP_HMAC_SECRET');
    expect(JSON.stringify(variables)).not.toContain('resolve:ssm-secure');

    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const statement = statements.find(({ Action }) => Action === 'ssm:GetParameters');
    expect(statement?.Effect).toBe('Allow');
    const resources = statement?.Resource as unknown[];
    expect(resources).toHaveLength(2);
    const serializedResources = JSON.stringify(resources);
    expect(serializedResources).toContain(
      `:ssm:${REGION}:${ACCOUNT}:parameter/test/turnstile-secret`,
    );
    expect(serializedResources).toContain(
      `:ssm:${REGION}:${ACCOUNT}:parameter/test/ip-hmac-secret`,
    );
    expect(serializedResources).not.toContain('*');
  });

  it('uses a deployable zero-cache score behavior with exact query forwarding', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    expect(distributions).toHaveLength(1);
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const scores = behaviors.find(({ PathPattern }) => PathPattern === 'scores*');
    expect(scores?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');

    // CloudFront rejects custom cache policies with every TTL at zero when they also
    // include cache-key values. Only the puzzle behavior should need a custom policy.
    expect(Object.values(template.findResources('AWS::CloudFront::CachePolicy'))).toHaveLength(1);

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    // The score policy, the profile policy (#188), the friends policy (#189), the
    // board policy (#190) and the round policy (#201) — each forwards exactly the
    // queries its handler route reads (the root AGENTS.md allowList contract).
    expect(policies).toHaveLength(5);
    const scorePolicy = policies.find(
      (policy) =>
        policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinLiveScoresOrigin',
    );
    // `id` joined the addressing triple with #203: the read reports the CALLER's own band,
    // so the handler needs the publicId naming them. An unlisted parameter never reaches the
    // Lambda, so the standing would silently go blank for everybody.
    expect(scorePolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: ['lang', 'date', 'mode', 'id'],
    });
    expect(scorePolicy?.Properties.OriginRequestPolicyConfig.CookiesConfig).toEqual({
      CookieBehavior: 'none',
    });

    // AWS's Lambda-URL policy pattern: every VIEWER header except Host, so the payload
    // hash reaches the origin (it can never be named in an allow-list) and CloudFront
    // sets Host to the Function URL's own domain for the SigV4 signature.
    expect(scorePolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });

  it('uses a deployable zero-cache profile behavior with exact query forwarding (#188)', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const profile = behaviors.find(({ PathPattern }) => PathPattern === 'profile*');
    // AWS's managed CachingDisabled policy — profile data is live, like /scores.
    expect(profile?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    // POST must be allowed (the authenticated upsert).
    expect(profile?.AllowedMethods).toContain('POST');

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    const profilePolicy = policies.find(
      (policy) =>
        policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinPlayerProfileOrigin',
    );
    // `id` is the ONE query the profile handler reads; the Lambda-URL-safe header mode
    // carries the viewer's x-amz-content-sha256 for the OAC-signed POST.
    expect(profilePolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: ['id'],
    });
    expect(profilePolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });

  it('uses a deployable zero-cache friends behavior forwarding NO query (#189)', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const friends = behaviors.find(({ PathPattern }) => PathPattern === 'friends*');
    // The graph is live data, like /scores and /profile.
    expect(friends?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    // The route is POST-only: the player key authenticates in the body.
    expect(friends?.AllowedMethods).toContain('POST');

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    const friendsPolicy = policies.find(
      (policy) => policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinFriendsOrigin',
    );
    // Nothing to forward: the handler reads no query parameter at all. The header mode is
    // still the Lambda-URL-safe one, since it is what carries the OAC-signed body hash.
    expect(friendsPolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'none',
    });
    expect(friendsPolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });

  it('uses a deployable zero-cache board behavior with exact query forwarding (#190)', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const board = behaviors.find(({ PathPattern }) => PathPattern === 'board*');
    // The leaderboard is live data, like the other three.
    expect(board?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    // POST must be allowed (the authenticated friends-board read).
    expect(board?.AllowedMethods).toContain('POST');

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    const boardPolicy = policies.find(
      (policy) => policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinLeaderboardOrigin',
    );
    // The FOUR queries the board handler reads — lang/date/mode address the day, `id`
    // (public, never the secret) widens the global GET with the caller's own window.
    expect(boardPolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: ['lang', 'date', 'mode', 'id'],
    });
    expect(boardPolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });

  it('uses a deployable zero-cache round behavior with exact query forwarding (#201)', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const round = behaviors.find(({ PathPattern }) => PathPattern === 'round*');
    // The guess log is live data, like the other four.
    expect(round?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    // The route is POST-only: the player key authenticates in the body.
    expect(round?.AllowedMethods).toContain('POST');

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    const roundPolicy = policies.find(
      (policy) => policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinRoundOrigin',
    );
    // The THREE addressing queries — the same triple /scores forwards; the secret never
    // travels in a query. The header mode is still the Lambda-URL-safe one, since it is
    // what carries the OAC-signed body hash.
    expect(roundPolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: ['lang', 'date', 'mode'],
    });
    expect(roundPolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });

  it('stamps the trusted viewer address onto EVERY route whose handler reads one', () => {
    // `allExcept` forwards viewer headers ONLY — never a CloudFront-GENERATED one — so the
    // policy above cannot deliver CloudFront-Viewer-Address, and a handler that needs a
    // trusted address throws without it. A viewer-request function supplies it instead.
    // Nothing else can catch this: `pnpm backend:dev` has no CDN, and the handler's own
    // tests hand it the header directly.
    //
    // Since #203 that is TWO routes. `/round` verifies both modes' Turnstile-gated round
    // START against the connecting address and records the day's score row metered by its
    // HMAC; `/scores` keeps the association because its own shape is unchanged.
    const functions = Object.values(template.findResources('AWS::CloudFront::Function'));
    expect(functions).toHaveLength(1);
    const code = functions[0].Properties.FunctionCode as string;
    expect(code).toContain(VIEWER_IP_HEADER);
    // CloudFront's own read of the connection, assigned outright — a merge or a
    // conditional would let a viewer choose the identity their submissions dedup on.
    expect(code).toContain('event.viewer.ip');
    expect(code).toMatch(
      new RegExp(`headers\\['${VIEWER_IP_HEADER}'\\]\\s*=\\s*\\{\\s*value:\\s*event\\.viewer\\.ip`),
    );

    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    for (const pattern of ['scores*', 'round*']) {
      const behavior = behaviors.find(({ PathPattern }) => PathPattern === pattern);
      const associations = behavior?.FunctionAssociations as { EventType: string }[];
      expect(associations, pattern).toHaveLength(1);
      // VIEWER_REQUEST runs before the cache lookup, so what it stamps IS a viewer header
      // by the time the origin request policy decides what to forward.
      expect(associations[0].EventType, pattern).toBe('viewer-request');
    }
    // The routes with no per-address logic stay clean.
    for (const pattern of ['profile*', 'board*', 'friends*']) {
      const behavior = behaviors.find(({ PathPattern }) => PathPattern === pattern);
      expect(behavior?.FunctionAssociations, pattern).toBeUndefined();
    }
  });
});

describe('per-player score storage (#187)', () => {
  it('keys the table (pk, sk) so one Query returns a day partition of player rows', () => {
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table'));
    expect(tables).toHaveLength(1);
    expect(tables[0].Properties.KeySchema).toEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ]);
    expect(tables[0].Properties.TimeToLiveSpecification).toEqual({
      AttributeName: 'expiresAt',
      Enabled: true,
    });
  });

  it('grants the handler exactly the row-store surface: Query, Get/BatchGet, conditional Put, Update, friend Delete', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as { Action?: unknown }[],
    );
    const statement = statements.find(
      ({ Action }) => Array.isArray(Action) && Action.includes('dynamodb:Query'),
    );
    expect(statement?.Action).toEqual([
      'dynamodb:Query',
      'dynamodb:GetItem',
      // #190's friends board reads a KNOWN key set in batches, never a Scan.
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      // #189's symmetric removal is the only thing on this table that deletes.
      'dynamodb:DeleteItem',
    ]);
  });
});
