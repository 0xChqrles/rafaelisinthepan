import { Stack, type StackProps, CfnOutput, Aws } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';

// GitHub Actions' OIDC identity provider — the same three constants for every account.
// The audience is fixed by aws-actions/configure-aws-credentials.
const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_DOMAIN = 'token.actions.githubusercontent.com';
const AUDIENCE = 'sts.amazonaws.com';

export interface DeployRoleStackProps extends StackProps {
  // GitHub repo owner (a personal account name OR an org — GitHub treats both the same
  // in the OIDC subject `repo:<owner>/<repo>:…`) and the repo name whose Actions runs
  // may assume the deploy role.
  githubOwner: string;
  githubRepo: string;
  // Branch whose pushes may assume the PROD deploy role. Subject:
  // `repo:<owner>/<repo>:ref:refs/heads/<branch>`. Matches deploy.yml (push to main).
  deployBranch?: string; // default "main"
  // Also create a SEPARATE, PR-scoped role (subject `repo:<owner>/<repo>:pull_request`)
  // for a future preview pipeline. Off by default — see the security note in the README:
  // a real preview boundary also needs a lower-privilege target, so this switch alone is
  // step one, not the whole story.
  enablePreviewRole?: boolean;
  // Import an EXISTING account-level GitHub OIDC provider by ARN instead of creating one.
  // Only ONE provider per URL is allowed per account, so if the account already has the
  // GitHub provider (e.g. from an earlier console attempt) pass its ARN here; otherwise
  // leave unset and this stack creates it.
  githubOidcProviderArn?: string;
}

// Bootstraps GitHub Actions' authentication to AWS (issue #33's `AWS_DEPLOY_ROLE_ARN`),
// as code instead of console clicks: the GitHub OIDC provider plus an IAM role the CI
// deploy workflow assumes via OIDC (no long-lived keys). Deployed ONCE by a human with
// account credentials — CI can't deploy this stack itself (its role can only assume the
// CDK bootstrap roles + read stack metadata; it deliberately cannot mint or edit IAM
// roles, so a compromised pipeline can't widen its own privileges).
export class DeployRoleStack extends Stack {
  constructor(scope: Construct, id: string, props: DeployRoleStackProps) {
    super(scope, id, props);

    const { githubOwner, githubRepo } = props;
    const deployBranch = props.deployBranch ?? 'main';
    const repo = `${githubOwner}/${githubRepo}`;

    // ── GitHub OIDC provider (account-level; import or create) ─────────────────
    const provider: iam.IOpenIdConnectProvider = props.githubOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GitHubOidc',
          props.githubOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
          url: GITHUB_OIDC_URL,
          clientIds: [AUDIENCE],
        });

    // ── What a role may DO ─────────────────────────────────────────────────────
    // Modern CDK deploys ENTIRELY through the account's `cdk bootstrap` roles: the CLI
    // (running as this role) just assumes them, and the actual CloudFormation/S3/asset
    // work runs under those already-least-privilege bootstrap roles. So the CI principal
    // needs only `sts:AssumeRole` on `cdk-hnb659fds-*` — plus `cloudformation:DescribeStacks`,
    // which `pnpm puzzle:publish --s3` calls directly (with the CI creds) to discover the
    // puzzle bucket name from the stack output (#4). Nothing here can mutate infrastructure
    // on its own — that power lives only in the assumed bootstrap roles.
    const cdkDeployPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'AssumeCdkBootstrapRoles',
          actions: ['sts:AssumeRole'],
          resources: [`arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/cdk-hnb659fds-*`],
        }),
        new iam.PolicyStatement({
          sid: 'DescribeStacks',
          actions: ['cloudformation:DescribeStacks'],
          resources: ['*'], // read-only metadata; puzzle:publish resolves the bucket output
        }),
      ],
    });

    // A role trusted ONLY by this repo's Actions for the given subject patterns (OR-ed).
    // aud is pinned to sts.amazonaws.com; sub is the repo + ref/PR scope — so no other
    // repo (and no other account) can assume it.
    const makeRole = (roleId: string, roleName: string, subjects: string[], description: string) =>
      new iam.Role(this, roleId, {
        roleName,
        description,
        assumedBy: new iam.OpenIdConnectPrincipal(provider, {
          StringEquals: { [`${GITHUB_OIDC_DOMAIN}:aud`]: AUDIENCE },
          StringLike: { [`${GITHUB_OIDC_DOMAIN}:sub`]: subjects },
        }),
        inlinePolicies: { CdkDeploy: cdkDeployPolicy },
      });

    // ── PROD deploy role — the AWS_DEPLOY_ROLE_ARN secret ──────────────────────
    // Scoped to pushes on <deployBranch> ONLY, so prod deploy power is unreachable from
    // pull-request code. (Fork PRs never receive an OIDC token at all, and same-repo PR
    // runs carry the `:pull_request` subject, which this role does not trust.)
    const deployRole = makeRole(
      'DeployRole',
      'whippin-github-deploy',
      [`repo:${repo}:ref:refs/heads/${deployBranch}`],
      `GitHub Actions prod deploy for ${repo} (push to ${deployBranch}).`,
    );

    new CfnOutput(this, 'DeployRoleArn', {
      description: 'Set as the GitHub repo secret AWS_DEPLOY_ROLE_ARN.',
      value: deployRole.roleArn,
    });

    // ── Optional preview role — PR-scoped, for a future preview pipeline ───────
    if (props.enablePreviewRole) {
      const previewRole = makeRole(
        'PreviewRole',
        'whippin-github-preview',
        [`repo:${repo}:pull_request`],
        `GitHub Actions PR-preview role for ${repo} (pull_request runs).`,
      );
      new CfnOutput(this, 'PreviewRoleArn', {
        description: 'Role assumable from PR runs (a future preview pipeline). See README security note.',
        value: previewRole.roleArn,
      });
    }

    new CfnOutput(this, 'GitHubOidcProviderArn', {
      description: 'The account GitHub Actions OIDC provider backing the deploy role(s).',
      value: provider.openIdConnectProviderArn,
    });

    // ── cdk-nag: accepted exceptions (each justified) ─────────────────────────
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'The deploy role assumes the CDK bootstrap roles by their fixed `cdk-hnb659fds-*` prefix (their full names embed account/region and are only known at deploy time) and reads stack metadata (`cloudformation:DescribeStacks` is read-only). All real infrastructure changes run through the assumed, least-privilege bootstrap roles — not this role.',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'The CDK-managed OIDC-provider custom resource uses an AWS managed policy; it is framework-authored, not defined here.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'The CDK-managed OIDC-provider custom-resource Lambda pins its own runtime; it is not configurable here.',
      },
    ]);
  }
}
