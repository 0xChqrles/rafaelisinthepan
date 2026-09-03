import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { VIEWER_IP_HEADER } from '@whippin/shared';
import { BackendStack } from './backend-stack';

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const TURNSTILE_PARAMETER = '/test/turnstile-secret';
const IP_HMAC_PARAMETER = '/test/ip-hmac-secret';
// #204's link codes need a verified sender. This template has no custom domain (a hosted
// zone lookup would need real credentials), so the sender is named outright — the same
// escape hatch a domain-less deployment uses.
const MAIL_FROM = 'hello@test.invalid';

function backendTemplate(): Template {
  const app = new App();
  const stack = new BackendStack(app, 'TestBackendStack', {
    env: { account: ACCOUNT, region: REGION },
    turnstileSecretParameter: TURNSTILE_PARAMETER,
    ipHmacSecretParameter: IP_HMAC_PARAMETER,
    mailFrom: MAIL_FROM,
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
    // board policy (#190), the round policy (#201), the history policy (#211), the
    // devices policy (#216) and the account-link policy (#204) — each forwards exactly the
    // queries its handler route reads (the root AGENTS.md allowList contract).
    expect(policies).toHaveLength(8);
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
    // The route is POST-only: the device token authenticates in the body.
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
    // The route is POST-only: the device token authenticates in the body.
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

  it('uses a deployable zero-cache devices behavior forwarding NO query (#216)', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const devices = behaviors.find(({ PathPattern }) => PathPattern === 'devices*');
    // Identity is live data, and a device list is private: it must never sit at the edge.
    expect(devices?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    // POST-only: the device token authenticates in the body.
    expect(devices?.AllowedMethods).toContain('POST');

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    const devicesPolicy = policies.find(
      (policy) => policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinDevicesOrigin',
    );
    // Nothing to forward — the /friends rule. The header mode still has to be the
    // Lambda-URL-safe one, since it is what carries the OAC-signed body hash.
    expect(devicesPolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'none',
    });
    expect(devicesPolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });

  it('uses a deployable zero-cache link behavior forwarding NO query (#204)', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const link = behaviors.find(({ PathPattern }) => PathPattern === 'link*');
    // An account link is live AND private: it must never sit at the edge.
    expect(link?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    // POST-only: the device token authenticates in the body, like /friends and /devices.
    expect(link?.AllowedMethods).toContain('POST');

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    const linkPolicy = policies.find(
      (policy) => policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinAccountLinkOrigin',
    );
    // Nothing to forward — the /friends rule. The header mode still has to be the
    // Lambda-URL-safe one, since it is what carries the OAC-signed body hash.
    expect(linkPolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'none',
    });
    expect(linkPolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });

  // CONTRACT (#204): the sender is one address, and the role may send as no other. A leaked
  // role must not be able to turn this account's SES reputation into somebody else's mail.
  it('grants ses:SendEmail only as the configured sender', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const send = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes('ses:SendEmail'),
    );
    expect(send).toHaveLength(1);
    expect(send[0].Condition).toEqual({ StringEquals: { 'ses:FromAddress': MAIL_FROM } });
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    expect(functions[0].Properties.Environment.Variables).toMatchObject({ MAIL_FROM });
  });

  it('uses a deployable zero-cache history behavior with exact query forwarding (#211)', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const behaviors = distributions[0].Properties.DistributionConfig.CacheBehaviors as Record<
      string,
      unknown
    >[];
    const history = behaviors.find(({ PathPattern }) => PathPattern === 'history*');
    // A player's own history is live AND private: it must never sit at the edge.
    expect(history?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    // POST-only: the device token authenticates in the body, like /friends and /round.
    expect(history?.AllowedMethods).toContain('POST');

    const policies = Object.values(
      template.findResources('AWS::CloudFront::OriginRequestPolicy'),
    );
    const historyPolicy = policies.find(
      (policy) =>
        policy.Properties.OriginRequestPolicyConfig.Name === 'WhippinPlayerHistoryOrigin',
    );
    // `lang`/`mode` name which game and `month` the calendar page — and NOT `date`: this
    // read is addressed by a MONTH, which is exactly the sort-key prefix #203 reordered
    // the round key for. An unlisted parameter never reaches the Lambda at all.
    expect(historyPolicy?.Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: ['lang', 'mode', 'month'],
    });
    expect(historyPolicy?.Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
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
    // Since #203 that is TWO routes, and since #216 THREE. `/round` verifies both modes'
    // Turnstile-gated round START against the connecting address and records the day's score
    // row metered by its HMAC; `/devices` verifies the gated bootstrap that mints an
    // identity; `/scores` keeps the association because its own shape is unchanged.
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
    // #204's link SEND is Turnstile-gated and metered per address, so it needs the trusted
    // address too.
    for (const pattern of ['scores*', 'round*', 'devices*', 'link*']) {
      const behavior = behaviors.find(({ PathPattern }) => PathPattern === pattern);
      const associations = behavior?.FunctionAssociations as { EventType: string }[];
      expect(associations, pattern).toHaveLength(1);
      // VIEWER_REQUEST runs before the cache lookup, so what it stamps IS a viewer header
      // by the time the origin request policy decides what to forward.
      expect(associations[0].EventType, pattern).toBe('viewer-request');
    }
    // The routes with no per-address logic stay clean.
    for (const pattern of ['profile*', 'board*', 'friends*', 'history*']) {
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

  it('indexes an account\'s devices, sparsely and off the authentication path (#216)', () => {
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table'));
    const indexes = tables[0].Properties.GlobalSecondaryIndexes as Record<string, unknown>[];
    // ONE index. Authentication is a direct base-table read by the token's hash, so the
    // index exists only for the sign-out screen's "which devices does this account have".
    expect(indexes).toHaveLength(1);
    expect(indexes[0].IndexName).toBe('DeviceByAccount');
    expect(indexes[0].KeySchema).toEqual([
      { AttributeName: 'gsi1pk', KeyType: 'HASH' },
      { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
    ]);
    // Enough to RENDER a device row; the base primary key comes along by construction and
    // is returned as the opaque handle used for a direct revocation delete.
    expect(indexes[0].Projection).toEqual({
      ProjectionType: 'INCLUDE',
      NonKeyAttributes: ['deviceId', 'accountId', 'agent', 'createdAt', 'lastSeenAt'],
    });
  });

  it('grants the handler exactly the row-store surface: Query, Get/BatchGet, conditional Put, Update, friend Delete, adoption ConditionCheck', () => {
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
      // #204's adoption asserts rows it does not write (the adopted account, a surviving
      // source, every guarded no-move). A standalone ConditionCheck element is authorized
      // by its OWN action — the Put/Update/Delete grants above do not cover it — so
      // without this the erasing link is an AccessDenied in production alone.
      'dynamodb:ConditionCheckItem',
    ]);
  });
});

// ── Mail plumbing (#230) ─────────────────────────────────────────────────────
// A SECOND template, because all of this hangs off the custom domain's hosted zone and the
// operator address. `fromLookup` resolves to a dummy zone with no credentials, which is
// enough: what is pinned below is shape, not zone contents.

const DOMAIN = 'test.invalid';
const OPERATOR = 'ops@test.invalid';

function mailTemplate(operatorEmail: string | undefined): Template {
  const app = new App();
  const stack = new BackendStack(app, 'MailBackendStack', {
    env: { account: ACCOUNT, region: REGION },
    turnstileSecretParameter: TURNSTILE_PARAMETER,
    ipHmacSecretParameter: IP_HMAC_PARAMETER,
    domainName: DOMAIN,
    operatorEmail,
  });
  return Template.fromStack(stack);
}

const mail = mailTemplate(OPERATOR);

describe('mail plumbing (#230)', () => {
  it('alarms on the rates AWS actually acts on, and stays quiet when nothing is sent', () => {
    const alarms = Object.values(mail.findResources('AWS::CloudWatch::Alarm')).map(
      (alarm) => alarm.Properties as Record<string, unknown>,
    );
    const byMetric = (metricName: string) =>
      alarms.find((alarm) => alarm.MetricName === metricName);

    // 5% bounce / 0.1% complaint are the rates AWS reviews an account at and can pause
    // sending over — not thresholds of our own choosing, which is why they are pinned.
    expect(byMetric('Reputation.BounceRate')).toMatchObject({
      Namespace: 'AWS/SES',
      Threshold: 0.05,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    expect(byMetric('Reputation.ComplaintRate')).toMatchObject({
      Namespace: 'AWS/SES',
      Threshold: 0.001,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    // SES publishes no reputation metric while the account is not sending — because the game
    // is quiet, OR because AWS has PAUSED it. `notBreaching` reads both as good, so an alarm
    // that had fired would drop to OK and mail a false recovery the moment the metric went
    // missing. Ignoring HOLDS the state: a quiet week wakes nobody, and a paused account is
    // never congratulated.
    for (const metricName of ['Reputation.BounceRate', 'Reputation.ComplaintRate']) {
      expect(byMetric(metricName)?.TreatMissingData).toBe('ignore');
    }
    // A mail that arrives and is then lost in silence is the same failure as one that never
    // arrives, and an ASYNC function has two ways of losing one: it ran and threw, or Lambda
    // gave up on the event without running it — retries exhausted, or aged out while
    // THROTTLED under the reserved concurrency, which is neither an error nor a log line.
    for (const metricName of ['Errors', 'AsyncEventsDropped']) {
      expect(byMetric(metricName)).toMatchObject({
        Namespace: 'AWS/Lambda',
        Threshold: 1,
        // Here silence IS good: a function that was not invoked dropped nothing.
        TreatMissingData: 'notBreaching',
      });
    }
  });

  it('lets the forwarder send RAW mail, to a recipient who is an identity, as ONE address', () => {
    // Learned from the first real message through it: SES authorizes a SendEmail carrying
    // raw content as ses:SendRawEmail, and evaluates the statement against the RECIPIENT's
    // identity when that recipient is a verified identity of the account — the operator's
    // own address, in a sandboxed account, always is. Without both the forwarder read the
    // message and was refused at the send, and the alarm was the only thing that worked.
    const statements = Object.values(mail.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const raw = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes('ses:SendRawEmail'),
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].Action).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
    expect(JSON.stringify(raw[0].Resource)).toContain(':identity/*');
    // The bound that matters survives: it may send as the one verified sender and no other.
    expect(raw[0].Condition).toEqual({ StringEquals: { 'ses:FromAddress': `hello@${DOMAIN}` } });
  });

  it('delivers a dropped forwarder event to the alerts topic, so the alarm names the message', () => {
    // The alarm says THAT a message was lost; the failed event (the SES notification, which
    // carries the message id and so the S3 key) says WHICH. The same topic rather than a
    // queue, because a queue nobody reads is the silence again.
    const configs = Object.values(mail.findResources('AWS::Lambda::EventInvokeConfig'));
    const onFailure = configs.map(
      (config) =>
        (config.Properties.DestinationConfig as { OnFailure?: { Destination: unknown } })
          ?.OnFailure?.Destination,
    );
    const [topicId] = Object.keys(mail.findResources('AWS::SNS::Topic'));
    expect(onFailure).toContainEqual({ Ref: topicId });
  });

  it('lets CloudWatch publish to the topic it alarms onto', () => {
    // `enforceSSL` attaches an explicit topic policy, and an explicit policy REPLACES the
    // default one SNS would apply. Without naming the publisher, all that is left is a Deny
    // — and an alarm that cannot publish is exactly the silence #230 exists to remove.
    const policies = Object.values(mail.findResources('AWS::SNS::TopicPolicy'));
    expect(policies).toHaveLength(1);
    const statements = policies[0].Properties.PolicyDocument.Statement as Record<
      string,
      unknown
    >[];
    const allow = statements.find((statement) => statement.Effect === 'Allow');
    expect(allow).toMatchObject({
      Action: 'sns:Publish',
      Principal: { Service: 'cloudwatch.amazonaws.com' },
      Condition: { StringEquals: { 'aws:SourceAccount': ACCOUNT } },
    });

    // The alarms are worth having only because a human is on the other end.
    mail.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: OPERATOR,
    });
  });

  it('points the apex MX at SES receiving in THIS stack’s region', () => {
    // SES receiving is regional and the MX must name the endpoint of the region whose rule
    // set is active. Naming another region's is mail accepted by nothing.
    mail.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'MX',
      Name: `${DOMAIN}.`,
      ResourceRecords: [`10 inbound-smtp.${REGION}.amazonaws.com`],
    });
  });

  it('receives for the four aliases, storing before it forwards', () => {
    const rules = Object.values(mail.findResources('AWS::SES::ReceiptRule'));
    expect(rules).toHaveLength(1);
    const rule = rules[0].Properties.Rule as Record<string, unknown>;
    expect(rule.Recipients).toEqual([
      // The sender #204's codes go out as — so a reply lands somewhere, and so does SES's
      // own bounce forwarding, which with no Return-Path set targets the From address.
      `hello@${DOMAIN}`,
      // Mailbox providers expect these two to exist.
      `abuse@${DOMAIN}`,
      `postmaster@${DOMAIN}`,
      // Somewhere for a DMARC `rua=` to point. Off-domain needs an authorization record
      // only that domain's owner can publish, so it has to be here.
      `dmarc@${DOMAIN}`,
    ]);
    expect(rule.ScanEnabled).toBe(true);

    // ORDER IS LOAD-BEARING: SES runs actions in sequence, and the forwarder reads the
    // object the S3 action wrote. Reversed, it is invoked before there is anything to read.
    const actions = rule.Actions as Record<string, unknown>[];
    expect(Object.keys(actions[0])).toEqual(['S3Action']);
    expect(Object.keys(actions[1])).toEqual(['LambdaAction']);
    // Asynchronous: this function makes no mail-flow decision, so a slow forward must never
    // become a bounce for the person who wrote.
    expect((actions[1].LambdaAction as Record<string, unknown>).InvocationType).toBe('Event');
  });

  it('activates the rule set, because an inactive one receives nothing', () => {
    // SES holds ONE active receipt rule set per region and exposes no CloudFormation
    // property for it. Left as a by-hand step, a complete deploy still receives no mail.
    const customs = Object.values(mail.findResources('Custom::AWS'));
    const activation = customs.find((resource) =>
      JSON.stringify(resource.Properties.Create ?? '').includes('setActiveReceiptRuleSet'),
    );
    expect(activation).toBeDefined();
    expect(JSON.stringify(activation!.Properties.Delete)).toContain('setActiveReceiptRuleSet');
  });

  it('holds received mail privately, and only as long as the notice says', () => {
    const buckets = Object.values(mail.findResources('AWS::S3::Bucket'));
    const inbound = buckets.find((bucket) =>
      JSON.stringify(bucket.Properties.LifecycleConfiguration ?? '').includes('inbound/'),
    );
    expect(inbound).toBeDefined();
    expect(inbound!.Properties.PublicAccessBlockConfiguration).toMatchObject({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    // This holds other people's mail, so the retention is a promise the privacy notice
    // makes on its behalf — "about 30 days", stated there, enforced here (S3 rounds expiry
    // up to the next UTC midnight and deletes asynchronously, which is why "about").
    const rules = inbound!.Properties.LifecycleConfiguration.Rules as Record<string, unknown>[];
    expect(rules[0]).toMatchObject({ Prefix: 'inbound/', ExpirationInDays: 30, Status: 'Enabled' });
  });

  it('builds none of it without an operator address', () => {
    // ALL OR NOTHING, deliberately: an alarm nobody is subscribed to and an MX nobody reads
    // are the failure this plumbing removes, not a lesser version of it.
    const bare = mailTemplate(undefined);
    expect(Object.keys(bare.findResources('AWS::CloudWatch::Alarm'))).toHaveLength(0);
    expect(Object.keys(bare.findResources('AWS::SNS::Topic'))).toHaveLength(0);
    expect(Object.keys(bare.findResources('AWS::SES::ReceiptRuleSet'))).toHaveLength(0);
    bare.resourcePropertiesCountIs('AWS::Route53::RecordSet', { Type: 'MX' }, 0);
  });
});
