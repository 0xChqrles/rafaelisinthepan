import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
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
    expect(policies).toHaveLength(1);
    expect(policies[0].Properties.OriginRequestPolicyConfig.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: ['lang', 'date', 'mode'],
    });
    expect(policies[0].Properties.OriginRequestPolicyConfig.CookiesConfig).toEqual({
      CookieBehavior: 'none',
    });

    // AWS's Lambda-URL policy pattern: all viewer/generated CloudFront headers except
    // Host. This carries x-amz-content-sha256 and CloudFront-Viewer-Address without
    // illegally naming the reserved x-amz-* header in an allow-list.
    expect(policies[0].Properties.OriginRequestPolicyConfig.HeadersConfig).toEqual({
      HeaderBehavior: 'allExcept',
      Headers: ['Host'],
    });
  });
});
