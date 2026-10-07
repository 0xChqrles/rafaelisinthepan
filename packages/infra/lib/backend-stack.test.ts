import { App, Aspects } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { VIEWER_IP_HEADER, preflightHeaders } from '@whippin/shared';
import { BackendStack } from './backend-stack';

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const TURNSTILE_PARAMETER = '/test/turnstile-secret';
const IP_HMAC_PARAMETER = '/test/ip-hmac-secret';
// #204's link codes need a verified sender. This template has no custom domain (a hosted
// zone lookup would need real credentials), so the sender is named outright — the same
// escape hatch a domain-less deployment uses.
const MAIL_FROM = 'hello@test.invalid';
// The web origin the API answers CORS for — the handler (its env) and the edge preflight alike.
const ALLOWED_ORIGIN = 'https://whippin.test';

function backendTemplate(): Template {
  const app = new App();
  const stack = new BackendStack(app, 'TestBackendStack', {
    env: { account: ACCOUNT, region: REGION },
    allowedOrigin: ALLOWED_ORIGIN,
    turnstileSecretParameter: TURNSTILE_PARAMETER,
    ipHmacSecretParameter: IP_HMAC_PARAMETER,
    mailFrom: MAIL_FROM,
  });
  return Template.fromStack(stack);
}

const template = backendTemplate();

const distributions = () =>
  Object.values(template.findResources('AWS::CloudFront::Distribution'));
const liveBehaviors = () =>
  distributions()[0].Properties.DistributionConfig.CacheBehaviors as Record<string, unknown>[];
const originRequestPolicies = () =>
  template.findResources('AWS::CloudFront::OriginRequestPolicy');

// What a live behavior's viewer-request function is, and what its code does.
function viewerRequestFunction(pattern: string): string {
  const behavior = liveBehaviors().find(({ PathPattern }) => PathPattern === pattern);
  const associations = behavior?.FunctionAssociations as
    | { EventType: string; FunctionARN: { 'Fn::GetAtt': [string, string] } }[]
    | undefined;
  expect(associations, pattern).toHaveLength(1);
  expect(associations![0].EventType, pattern).toBe('viewer-request');
  return associations![0].FunctionARN['Fn::GetAtt'][0];
}
function functionCode(logicalId: string): string {
  return template.findResources('AWS::CloudFront::Function')[logicalId].Properties.FunctionCode as string;
}
function viewerIpFunctionId(): string {
  const [id] = Object.entries(template.findResources('AWS::CloudFront::Function')).find(([, fn]) =>
    (fn.Properties.FunctionCode as string).includes(VIEWER_IP_HEADER),
  )!;
  return id;
}
// The stack's two backend functions, told apart by their construct ids: the API (`PuzzleFn`)
// and #207's purge worker (`PurgeFn`).
function lambdaFunction(t: Template, prefix: 'PuzzleFn' | 'PurgeFn') {
  const found = Object.entries(t.findResources('AWS::Lambda::Function')).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(found, prefix).toHaveLength(1);
  const [logicalId, resource] = found[0];
  return { logicalId, properties: resource.Properties as Record<string, any> };
}
// Every statement of the policies attached to a function's own role.
function roleStatements(t: Template, prefix: 'PuzzleFn' | 'PurgeFn'): Record<string, unknown>[] {
  const role = lambdaFunction(t, prefix).properties.Role['Fn::GetAtt'][0] as string;
  return Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(`"${role}"`))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]);
}

// Run an edge function's code on a viewer request of `method` (the CloudFront event's shape).
function runEdgeFunction(code: string, method: string): unknown {
  const handler = new Function(`${code}\nreturn handler;`)() as (event: unknown) => unknown;
  return handler({ request: { method, uri: '/board', headers: {} }, viewer: { ip: '203.0.113.7' } });
}

// AWS's managed CachingDisabled cache policy.
const CACHING_DISABLED_POLICY_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

// The root AGENTS.md route table, row for row: each LIVE route's behavior, the
// origin-request policy it wears and the queries that policy forwards — exactly what its
// handler reads. It is one third of a three-package contract, and `backend:dev` has no CDN
// to show a drift. `post` is off for /scores alone: that route is read-only (a POST is a
// 405), so nothing depends on the method being allowed there.
const LIVE_ROUTES = [
  {
    pattern: 'scores*',
    policy: 'WhippinLiveScoresOrigin',
    queries: ['lang', 'date', 'id'],
    post: false,
    why: 'the day, and the public id of the caller whose own band the read reports (#203)',
  },
  {
    pattern: 'board*',
    policy: 'WhippinLeaderboardOrigin',
    queries: ['lang', 'date', 'id'],
    post: true,
    why: 'the day, and the public id widening the global GET with the caller\'s window (#190)',
  },
  {
    pattern: 'round*',
    policy: 'WhippinRoundOrigin',
    queries: ['lang', 'date', 'bonus'],
    post: true,
    why: 'the day, or a bonus puzzle\'s id standing in for the date (#201)',
  },
  {
    pattern: 'history*',
    policy: 'WhippinPlayerHistoryOrigin',
    queries: ['lang', 'month'],
    post: true,
    why: 'a calendar page is addressed by MONTH, never by date (#211)',
  },
  {
    pattern: 'profile*',
    policy: 'WhippinPlayerProfileOrigin',
    queries: ['id'],
    post: true,
    why: 'the public id a board row resolves by (#188)',
  },
  {
    pattern: 'groups*',
    policy: 'WhippinGroupsOrigin',
    queries: ['id'],
    post: true,
    why: 'the public group id the GET answers a face for (#271)',
  },
  {
    pattern: 'devices*',
    policy: 'WhippinDevicesOrigin',
    queries: [],
    post: true,
    why: 'the device token rides in the body (#216)',
  },
  {
    pattern: 'link*',
    policy: 'WhippinAccountLinkOrigin',
    queries: [],
    post: true,
    why: 'the device token rides in the body (#204)',
  },
];

describe('score production boundary (#169)', () => {
  it('passes only parameter names to Lambda and grants one exact GetParameters read', () => {
    // The API and the purge worker (#207), and no other function.
    expect(Object.keys(template.findResources('AWS::Lambda::Function'))).toHaveLength(2);
    const variables = lambdaFunction(template, 'PuzzleFn').properties.Environment
      .Variables as Record<string, unknown>;
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

  it('caches the puzzle route alone, keyed on every query it reads', () => {
    expect(distributions()).toHaveLength(1);
    // CloudFront rejects custom cache policies with every TTL at zero when they also
    // include cache-key values. Only the puzzle behavior should need a custom policy.
    const cachePolicies = Object.values(template.findResources('AWS::CloudFront::CachePolicy'));
    expect(cachePolicies).toHaveLength(1);
    // …and its cache key IS what reaches the Lambda: every query the puzzle route reads.
    expect(
      cachePolicies[0].Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin
        .QueryStringsConfig,
    ).toEqual({ QueryStringBehavior: 'whitelist', QueryStrings: ['lang', 'date', 'bonus'] });
  });

  it('gives each live route its own origin-request policy, and builds no other', () => {
    expect(Object.keys(originRequestPolicies())).toHaveLength(LIVE_ROUTES.length);
  });

  // The title is built here rather than interpolated by `it.each`, which would cut the
  // reason short.
  it.each(
    LIVE_ROUTES.map(
      (route) =>
        [`${route.pattern} forwards exactly [${route.queries.join(', ')}]: ${route.why}`, route] as const,
    ),
  )('zero-cache live behavior %s', (_title, { pattern, policy, queries, post }) => {
    const behavior = liveBehaviors().find(({ PathPattern }) => PathPattern === pattern);
    // AWS's managed CachingDisabled policy: live data must never sit at the edge, and
    // never inherit the puzzle's year-long s-maxage.
    expect(behavior?.CachePolicyId).toBe(CACHING_DISABLED_POLICY_ID);
    if (post) expect(behavior?.AllowedMethods).toContain('POST');

    // The policy THIS behavior wears, not merely one that exists under the name.
    const { Ref } = behavior?.OriginRequestPolicyId as { Ref: string };
    const config = originRequestPolicies()[Ref]?.Properties.OriginRequestPolicyConfig;
    expect(config?.Name).toBe(policy);
    // An unlisted parameter never reaches the Lambda at all; an empty list forwards none.
    expect(config?.QueryStringsConfig).toEqual(
      queries.length
        ? { QueryStringBehavior: 'whitelist', QueryStrings: queries }
        : { QueryStringBehavior: 'none' },
    );
    expect(config?.CookiesConfig).toEqual({ CookieBehavior: 'none' });
    // AWS's Lambda-URL policy pattern: every VIEWER header except Host, so the payload
    // hash reaches the origin (it can never be named in an allow-list) and CloudFront
    // sets Host to the Function URL's own domain for the SigV4 signature.
    expect(config?.HeadersConfig).toEqual({ HeaderBehavior: 'allExcept', Headers: ['Host'] });
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
    // Every identity, not the domain alone: a verified RECIPIENT is an identity the send is
    // authorized against too (2026-09-12), and the sender bound above is the guard that matters.
    expect(JSON.stringify(send[0].Resource)).toContain(':identity/*');
    expect(lambdaFunction(template, 'PuzzleFn').properties.Environment.Variables).toMatchObject({
      MAIL_FROM,
    });
  });

  it('stamps the trusted viewer address onto EVERY route whose handler reads one', () => {
    // `allExcept` forwards viewer headers ONLY — never a CloudFront-GENERATED one — so the
    // policy above cannot deliver CloudFront-Viewer-Address, and a handler that needs a
    // trusted address throws without it. A viewer-request function supplies it instead.
    // Nothing else can catch this: `pnpm backend:dev` has no CDN, and the handler's own
    // tests hand it the header directly.
    //
    // Since #203 that is TWO routes, and since #216 THREE. `/round` verifies the
    // Turnstile-gated round creation against the connecting address and records the day's
    // score row metered by its HMAC; `/devices` verifies the gated bootstrap that mints an
    // identity; `/scores` keeps the association because its own shape is unchanged.
    const code = functionCode(viewerIpFunctionId());
    expect(code).toContain(VIEWER_IP_HEADER);
    // CloudFront's own read of the connection, assigned outright — a merge or a
    // conditional would let a viewer choose the identity their submissions dedup on.
    expect(code).toContain('event.viewer.ip');
    expect(code).toMatch(
      new RegExp(`headers\\['${VIEWER_IP_HEADER}'\\]\\s*=\\s*\\{\\s*value:\\s*event\\.viewer\\.ip`),
    );
    const stamped = runEdgeFunction(code, 'POST') as { headers: Record<string, { value: string }> };
    expect(stamped.headers[VIEWER_IP_HEADER]).toEqual({ value: '203.0.113.7' });

    // #204's link SEND is Turnstile-gated and metered per address, so it needs the trusted
    // address too. VIEWER_REQUEST runs before the cache lookup, so what it stamps IS a viewer
    // header by the time the origin request policy decides what to forward.
    for (const pattern of ['scores*', 'round*', 'devices*', 'link*']) {
      expect(viewerRequestFunction(pattern), pattern).toBe(viewerIpFunctionId());
    }
    // The routes with no per-address logic never receive the address.
    for (const pattern of ['profile*', 'board*', 'groups*', 'history*']) {
      expect(viewerRequestFunction(pattern), pattern).not.toBe(viewerIpFunctionId());
      expect(functionCode(viewerRequestFunction(pattern))).not.toContain(VIEWER_IP_HEADER);
    }
  });

  it('answers EVERY live route\'s CORS preflight at the edge, with the handler\'s own headers', () => {
    // The permission check in front of each live POST never reaches the Lambda: the
    // behavior's viewer-request function answers it with the SHARED preflight headers, so the
    // edge and the handler (`backend:dev`, the puzzle route) cannot answer it two ways.
    const functions = template.findResources('AWS::CloudFront::Function');
    expect(Object.keys(functions)).toHaveLength(2);
    // Every behavior the distribution adds is a live route (the table above, row for row) —
    // so a new one wearing no function fails here.
    const patterns = liveBehaviors().map(({ PathPattern }) => PathPattern as string);
    expect([...patterns].sort()).toEqual(LIVE_ROUTES.map(({ pattern }) => pattern).sort());
    // The two speakers answer for ONE origin: the handler's env, and the edge's code.
    const lambdas = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (fn) => fn.Properties.Environment?.Variables?.ALLOWED_ORIGIN !== undefined,
    );
    expect(lambdas).toHaveLength(1);
    expect(lambdas[0].Properties.Environment.Variables.ALLOWED_ORIGIN).toBe(ALLOWED_ORIGIN);
    for (const pattern of patterns) {
      const answer = runEdgeFunction(functionCode(viewerRequestFunction(pattern)), 'OPTIONS') as {
        statusCode: number;
        headers: Record<string, { value: string }>;
      };
      expect(answer.statusCode, pattern).toBe(204);
      expect(answer.headers, pattern).toEqual(
        Object.fromEntries(
          Object.entries(preflightHeaders(ALLOWED_ORIGIN)).map(([name, value]) => [name.toLowerCase(), { value }]),
        ),
      );
      // Any other method goes on to the origin.
      expect(runEdgeFunction(functionCode(viewerRequestFunction(pattern)), 'POST'), pattern).toMatchObject({
        method: 'POST',
      });
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

  it('grants the handler exactly the row-store surface: Query, Get/BatchGet, conditional Put, Update, membership Delete, adoption ConditionCheck', () => {
    const statement = roleStatements(template, 'PuzzleFn').find(
      ({ Action }) => Array.isArray(Action) && Action.includes('dynamodb:Query'),
    );
    expect(statement?.Action).toEqual(ROW_STORE_SURFACE);
  });

  it('grants no function a Scan', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as { Action?: unknown }[],
    );
    expect(JSON.stringify(statements.map(({ Action }) => Action))).not.toContain('dynamodb:Scan');
  });
});

// The handler's row-store surface, action by action — and, since #207, the purge worker's,
// which runs the same stores.
const ROW_STORE_SURFACE = [
      'dynamodb:Query',
      'dynamodb:GetItem',
      // #190's group board reads a KNOWN key set in batches, never a Scan.
      'dynamodb:BatchGetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      // Leaving a group (#271), device revocation and #204's erase are what delete here.
      'dynamodb:DeleteItem',
      // #204's adoption asserts rows it does not write (the adopted account, a surviving
      // source, every guarded no-move). A standalone ConditionCheck element is authorized
      // by its OWN action — the Put/Update/Delete grants above do not cover it — so
      // without this the erasing link is an AccessDenied in production alone.
      'dynamodb:ConditionCheckItem',
];

// ── Mail plumbing (#230) ─────────────────────────────────────────────────────
// A SECOND template, because all of this hangs off the custom domain's hosted zone and the
// operator address. `fromLookup` resolves to a dummy zone with no credentials, which is
// enough: what is pinned below is shape, not zone contents.

const DOMAIN = 'test.invalid';
const OPERATOR = 'ops@test.invalid';

function mailStack(app: App, operatorEmail: string | undefined): BackendStack {
  return new BackendStack(app, 'MailBackendStack', {
    env: { account: ACCOUNT, region: REGION },
    turnstileSecretParameter: TURNSTILE_PARAMETER,
    ipHmacSecretParameter: IP_HMAC_PARAMETER,
    domainName: DOMAIN,
    operatorEmail,
  });
}

function mailTemplate(operatorEmail: string | undefined): Template {
  return Template.fromStack(mailStack(new App(), operatorEmail));
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

// ── The account purge worker (#207) ──────────────────────────────────────────
describe('account purge worker (#207)', () => {
  it('is one sweeper at a time, given the table and nothing else', () => {
    const { properties } = lambdaFunction(template, 'PurgeFn');
    expect(properties).toMatchObject({
      Handler: 'index.handler',
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 512,
      Timeout: 300,
      // Two runs over one job would race each other's conditional deletes.
      ReservedConcurrentExecutions: 1,
    });
    // No secret, no origin, no sender: it verifies no challenge and sends nothing.
    const [tableId] = Object.keys(template.findResources('AWS::DynamoDB::Table'));
    expect(properties.Environment.Variables).toEqual({ SCORE_TABLE: { Ref: tableId } });
    // Its logs expire like the API's, rather than accumulating forever.
    const logGroup = properties.LoggingConfig.LogGroup.Ref as string;
    expect(template.findResources('AWS::Logs::LogGroup')[logGroup].Properties.RetentionInDays).toBe(30);
  });

  it('runs every hour, and the hour is its only retry', () => {
    const { logicalId } = lambdaFunction(template, 'PurgeFn');
    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    expect(rules).toHaveLength(1);
    expect(rules[0].Properties).toMatchObject({
      ScheduleExpression: 'rate(1 hour)',
      State: 'ENABLED',
      Targets: [{ Arn: { 'Fn::GetAtt': [logicalId, 'Arn'] } }],
    });
    // EventBridge may invoke it…
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      FunctionName: { 'Fn::GetAtt': [logicalId, 'Arn'] },
      Principal: 'events.amazonaws.com',
    });
    // …and Lambda does not re-run a failed sweep behind it: the next hour does.
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: logicalId },
      MaximumRetryAttempts: 0,
    });
  });

  it('reaches the table through the API\'s own surface, the device index included', () => {
    const statement = roleStatements(template, 'PurgeFn').find(
      ({ Action }) => Array.isArray(Action) && Action.includes('dynamodb:Query'),
    );
    // A group leave's transaction asserts rows it does not write: without
    // ConditionCheckItem a deleted owner's group never changes hands, in production alone.
    expect(statement?.Action).toEqual(ROW_STORE_SURFACE);
    // The deleted account's devices are listed off the DeviceByAccount GSI.
    expect(JSON.stringify(statement?.Resource)).toContain('/index/*');
  });

  it('alarms onto the operator topic when a purge fails, and only with one', () => {
    const { logicalId } = lambdaFunction(mail, 'PurgeFn');
    const alarm = Object.values(mail.findResources('AWS::CloudWatch::Alarm'))
      .map((resource) => resource.Properties as Record<string, unknown>)
      .find(({ Dimensions }) => JSON.stringify(Dimensions ?? null).includes(`"${logicalId}"`));
    const [topicId] = Object.keys(mail.findResources('AWS::SNS::Topic'));
    expect(alarm).toMatchObject({
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Statistic: 'Sum',
      Period: 86400,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      // An idle hour failed nothing.
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: topicId }],
    });
    // The worker itself is built either way: a deleted account is purged whether or not
    // anybody is told when it fails.
    lambdaFunction(mailTemplate(undefined), 'PurgeFn');
  });
});

// `bin/app.ts` runs cdk-nag over every stack, where a finding is a FAILED SYNTH — and CI
// synthesizes nothing, so without this a finding is first seen by the deploy, after the
// merge (`bot-stack.test.ts` records how one reached production). Built WITH the domain
// and the operator address, so the mail constructs and their suppressions are checked too.
describe('cdk-nag (the gate bin/app.ts applies)', () => {
  it('synthesizes with NO cdk-nag findings, mail plumbing included', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = mailStack(app, OPERATOR);
    Aspects.of(app).add(new AwsSolutionsChecks());
    expect(
      Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
    ).toEqual([]);
  });
});
