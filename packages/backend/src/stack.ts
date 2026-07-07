// Infra identifiers read from the deployed backend stack — the SINGLE source of truth is
// packages/infra (the stack id in bin/app.ts, the CfnOutput ids in lib/backend-stack.ts).
// Shared by `publish` (bucket + distribution, to write and invalidate) and `inventory`
// (bucket, to probe) so the lookup is not duplicated (#61). The stack is pinned to
// us-east-1 (see bin/app.ts), so its outputs and its bucket live there.
const STACK_NAME = 'WhippinBackendStack';
const BUCKET_OUTPUT_KEY = 'PuzzleBucketName';
const DISTRIBUTION_OUTPUT_KEY = 'DistributionId';
export const STACK_REGION = 'us-east-1';

// Resolve the puzzle bucket + API distribution from the deployed stack's outputs. Needs
// AWS creds (already required to touch S3) + `cloudformation:DescribeStacks`. The SDK is
// imported lazily so importing this module — or the local publish/inventory paths — stays
// AWS-free. Throws a clear, actionable error if the stack/output is missing; the CLIs turn
// that into a clean `die`.
export async function stackOutputs(): Promise<{ bucket: string; distributionId: string }> {
  const { CloudFormationClient, DescribeStacksCommand } = await import(
    '@aws-sdk/client-cloudformation'
  );
  const cf = new CloudFormationClient({ region: STACK_REGION });
  const res = await cf.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = res.Stacks?.[0]?.Outputs;
  const get = (key: string): string => {
    const value = outputs?.find((o) => o.OutputKey === key)?.OutputValue;
    if (!value) {
      throw new Error(
        `stack "${STACK_NAME}" (${STACK_REGION}) has no "${key}" output — ` +
          `deploy the infra package first (pnpm infra:deploy).`,
      );
    }
    return value;
  };
  return { bucket: get(BUCKET_OUTPUT_KEY), distributionId: get(DISTRIBUTION_OUTPUT_KEY) };
}
