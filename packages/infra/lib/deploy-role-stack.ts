import { Stack, type StackProps, CfnOutput, Aws } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';

// GitHub Actions' OIDC identity provider — the same three constants for every account.
// The audience is fixed by aws-actions/configure-aws-credentials.
const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_DOMAIN = 'token.actions.githubusercontent.com';
const AUDIENCE = 'sts.amazonaws.com';

interface DeployRoleStackProps extends StackProps {
  // GitHub repo owner (a personal account name OR an org — GitHub treats both the same
  // in the OIDC subject `repo:<owner>/<repo>:…`) and the repo name whose Actions runs
  // may assume the deploy role.
  githubOwner: string;
  githubRepo: string;
  // Branch whose pushes may assume the PROD deploy role. Subject:
  // `repo:<owner>/<repo>:ref:refs/heads/<branch>`. Matches deploy.yml (push to main).
  deployBranch?: string; // default "main"
  // The GitHub OIDC provider is ACCOUNT-GLOBAL — at most ONE per URL per account. By
  // default this stack IMPORTS the account's existing provider (its ARN is derived from
  // the account id below, so nothing is hardcoded): GitHub's provider is very often
  // already present, and creating a duplicate fails with `EntityAlreadyExists`. Set
  // `createOidcProvider` only on a fresh account that has none yet.
  createOidcProvider?: boolean;
  // Import a SPECIFIC provider ARN (overrides both defaults above). Rarely needed — the
  // derived account ARN already targets the standard GitHub provider.
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

    // ── GitHub OIDC provider (account-global; import by default, create if asked) ──
    // The provider is one-per-account, so the common case is that it already exists:
    // IMPORT the account's provider via its derived ARN (built from AWS::AccountId, no
    // hardcoded account). Only `createOidcProvider` makes a new one (a fresh account),
    // and `githubOidcProviderArn` imports a specific ARN if ever needed.
    const derivedProviderArn = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:oidc-provider/${GITHUB_OIDC_DOMAIN}`;
    const provider: iam.IOpenIdConnectProvider = props.createOidcProvider
      ? new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
          url: GITHUB_OIDC_URL,
          clientIds: [AUDIENCE],
        })
      : iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GitHubOidc',
          props.githubOidcProviderArn ?? derivedProviderArn,
        );

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
        // Puzzle responses carry a YEAR-long s-maxage, so the edge keeps serving a body that
        // a code deploy may have just changed — a new Content-Encoding, new bytes, new
        // headers. `puzzle:publish --s3` already purges after an upload for exactly this
        // reason; deploy.yml now does the same after `cdk deploy`, and needs the permission
        // to do it. This does NOT loosen the boundary the comment above draws: an
        // invalidation reads nothing, mutates no infrastructure, and grants no privilege —
        // the worst it can do is force cache misses. (The role's real power was always the
        // bootstrap roles it may assume, not this.)
        new iam.PolicyStatement({
          sid: 'InvalidateApiCdn',
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/*`],
        }),
        // The WhatsApp bot's group configs (#236) live in SSM, and `deploy-bot` pulls them
        // into the gitignored snapshot it builds the image, the Lambda bundle and the podium
        // SCHEDULES from. READ-ONLY and confined to that one path: this role deploys, it does
        // not decide which groups the bot acts in — that stays an operator act through
        // `pnpm bot:groups`. `GetParametersByPath` is authorized against the PATH itself, so
        // both it and the parameters beneath it are named.
        new iam.PolicyStatement({
          sid: 'ReadBotGroupConfigs',
          actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
          resources: [
            `arn:${Aws.PARTITION}:ssm:*:${Aws.ACCOUNT_ID}:parameter/whippin/bot/groups`,
            `arn:${Aws.PARTITION}:ssm:*:${Aws.ACCOUNT_ID}:parameter/whippin/bot/groups/*`,
          ],
        }),
      ],
    });

    // ── PROD deploy role — the AWS_DEPLOY_ROLE_ARN secret ──────────────────────
    // Trusted ONLY by this repo's Actions: aud is pinned to sts.amazonaws.com; sub is the
    // repo + ref scope — so no other repo (and no other account) can assume it.
    // Scoped to pushes on <deployBranch> ONLY, so prod deploy power is unreachable from
    // pull-request code. (Fork PRs never receive an OIDC token at all, and same-repo PR
    // runs carry the `:pull_request` subject, which this role does not trust.)
    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'whippin-github-deploy',
      description: `GitHub Actions prod deploy for ${repo} (push to ${deployBranch}).`,
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { [`${GITHUB_OIDC_DOMAIN}:aud`]: AUDIENCE },
        StringLike: {
          [`${GITHUB_OIDC_DOMAIN}:sub`]: [`repo:${repo}:ref:refs/heads/${deployBranch}`],
        },
      }),
      inlinePolicies: { CdkDeploy: cdkDeployPolicy },
    });

    new CfnOutput(this, 'DeployRoleArn', {
      description: 'Set as the GitHub repo secret AWS_DEPLOY_ROLE_ARN.',
      value: deployRole.roleArn,
    });

    new CfnOutput(this, 'GitHubOidcProviderArn', {
      description: 'The account GitHub Actions OIDC provider backing the deploy role(s).',
      value: provider.openIdConnectProviderArn,
    });

    // ── cdk-nag: accepted exceptions (each justified) ─────────────────────────
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'The deploy role assumes the CDK bootstrap roles by their fixed `cdk-hnb659fds-*` prefix (their full names embed account/region and are only known at deploy time) and reads stack metadata (`cloudformation:DescribeStacks` is read-only). `cloudfront:CreateInvalidation` is scoped to this account\'s distributions by wildcard because the distribution id is generated at deploy time and is discovered from the stack output at run time; the action reads nothing, mutates no infrastructure, and cannot escalate privilege. The bot group-config read is scoped by path to `/whippin/bot/groups/*`, whose leaf names are operator-chosen slugs unknown at synth; it is read-only over product configuration that carries no secret. All real infrastructure changes run through the assumed, least-privilege bootstrap roles — not this role.',
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
