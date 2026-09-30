import { App, Aspects } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { DeployRoleStack } from './deploy-role-stack';

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';

// `bin/app.ts` runs cdk-nag over every stack, where a finding is a FAILED SYNTH — every
// cdk command constructs this stack, so a finding here fails the app stacks' deploy too,
// and CI synthesizes nothing. Both provider modes: importing the account's provider (the
// default) and creating it (`-c createOidcProvider=true`, which adds a custom resource
// with suppressions of its own).
describe('CI deploy role stack (#33)', () => {
  it.each([
    ['importing the account OIDC provider', false],
    ['creating the OIDC provider', true],
  ])('synthesizes with NO cdk-nag findings, %s', (_mode, createOidcProvider) => {
    const app = new App();
    const stack = new DeployRoleStack(app, 'TestDeployStack', {
      env: { account: ACCOUNT, region: REGION },
      githubOwner: 'owner',
      githubRepo: 'repo',
      createOidcProvider,
    });
    Aspects.of(app).add(new AwsSolutionsChecks());
    expect(
      Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
    ).toEqual([]);
  });
});
