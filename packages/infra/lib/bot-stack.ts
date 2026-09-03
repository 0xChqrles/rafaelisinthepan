// The WhatsApp bot's stack (#236) — a SIBLING of the backend and web stacks, sharing
// nothing with them: a broken Baileys release, an expired session, a model outage or a bot
// deploy has no path to the game, puzzle publishing or the public leaderboard. It consumes
// Whippin's public share-token contract; nothing in the game depends on it.
//
//   ONE Fargate task (desiredCount 1, stop-before-start) holding the ONE Baileys session,
//   a bot-owned DynamoDB table (auth, declarations, memory, outbound dedup, limits),
//   an SQS outbound queue the task consumes and a scheduled Lambda produces into,
//   one EventBridge schedule per configured group, at that group's own local time,
//   and the alarms that say "disconnected" instead of letting the service claim health.
//
// NETWORKING IS DELIBERATELY CHEAP: public subnets, a public IP, no inbound rule, no NAT
// gateway — the task needs outbound Internet (WhatsApp, DeepSeek) and nothing needs to
// reach it. AWS API access is IAM. Revisit endpoints/NAT only if the wider infra gains
// private networking for another reason.
//
// Group behaviour is CONFIGURATION: the pulled `packages/whatsapp-bot/groups/local/*.json`
// snapshot (from SSM, via `pnpm bot:groups pull`) is read at synth to create the podium
// schedules and copied into both the image and the Lambda bundle. Adding a community is a
// config change, not a code change here.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Stack,
  type StackProps,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Aws,
  Annotations,
  ArnFormat,
  TimeZone,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { readGroupConfigsForSynth, type GroupConfig } from '@whippin/whatsapp-bot/config';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/infra/lib
const REPO_ROOT = path.resolve(here, '..', '..', '..');
const BOT_DIR = path.resolve(REPO_ROOT, 'packages', 'whatsapp-bot');
const BOT_DOCKERFILE = path.join('packages', 'whatsapp-bot', 'Dockerfile'); // relative to the context
const PODIUM_ENTRY = path.join(BOT_DIR, 'src', 'podiumJob.ts');
// The pulled SNAPSHOT (`pnpm bot:groups pull`), never the repository: SSM is the source of
// truth for group configs and this directory is gitignored. Absent or empty is a legitimate
// synth (every cdk command in this repo constructs this stack, including the ones deploying
// the web and backend), so the guard against deploying an accidentally empty set is the
// WARNING below plus the pull step in `deploy.yml` — not a throw here. That tolerance is
// SYNTH's alone (`readGroupConfigsForSynth`): the runtime reads the same directory through
// `loadGroups`, where a missing one is a misconfigured BOT_GROUPS_DIR and fails the boot.
const GROUPS_DIR = path.join(BOT_DIR, 'groups', 'local');
const REPO_LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml');

export const BOT_METRICS_NAMESPACE = 'WhippinBot';
export const CONNECTED_METRIC = 'Connected';

interface BotStackProps extends StackProps {
  // Where a human is reached: the confirmed SNS subscription behind the alarms. No default
  // (personal address, public repo); unset, the alarms exist but notify nobody.
  operatorEmail?: string;
  // SSM SecureString holding the model provider's API key. The environment carries the NAME.
  llmApiKeyParameter?: string;
  llmProvider?: string;
  llmModel?: string;
  // The site whose share links the bot recognises.
  siteOrigin?: string;
  // Override for tests: the directory of group configs read at synth.
  groupsDir?: string;
}

export class BotStack extends Stack {
  constructor(scope: Construct, id: string, props: BotStackProps = {}) {
    super(scope, id, props);

    const llmApiKeyParameter = props.llmApiKeyParameter ?? '/whippin/bot/llm-api-key';
    const llmProvider = props.llmProvider ?? 'deepseek';
    const llmModel = props.llmModel ?? 'deepseek-v4-flash';
    const siteOrigin = props.siteOrigin ?? 'https://whippin.ai';
    const groupsDir = props.groupsDir ?? GROUPS_DIR;
    const groups = readGroupConfigsForSynth(groupsDir).filter((g) => g.enabled);
    if (groups.length === 0) {
      Annotations.of(this).addWarning(
        'No enabled group in the snapshot: this deploy would leave the bot with no group and no podium schedule. Run `pnpm bot:groups pull` first (deploy.yml does).',
      );
    }

    // ── DynamoDB: the bot's own table, every keyspace ────────────────────────
    // `AUTH#bot` (Baileys creds + Signal keys, the lease), `GROUP#<jid>` (declarations,
    // leader state), `MEMORY#<jid>`, `OUTBOX#<jid>`, `LIMIT#…`. Keyspaces share a table
    // and keep separate store interfaces in code. RETAIN + PITR: the auth state is the one
    // thing here that cannot be regenerated without a phone in hand. `expiresAt` TTL serves
    // the transient counters only; auth and score rows never carry it.
    const table = new dynamodb.Table(this, 'BotTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── SQS: the outbound command queue ──────────────────────────────────────
    // The connected task is the ONLY WhatsApp sender; a podium job produces a command here.
    // Visibility timeout covers one send; a command that fails five deliveries lands in the
    // DLQ, which is alarmed — a podium that could not go out must not vanish quietly.
    //
    // Five is a count of REAL failures, not of disconnected polls: the consumer does not
    // receive at all while the socket is down (`runConsumer`'s ready gate), and a message
    // already in hand when the socket drops is hidden for `DEFER_SECONDS` (five minutes)
    // rather than left to this timeout — so a reconnection does not spend a message's
    // deliveries and push a perfectly good podium into the dead-letter queue while the
    // disconnection alarm is already ringing. Five deferrals span about 25 minutes; a
    // disconnection longer than that is the alarm's business, and the message's arrival
    // in the DLQ then says a podium was missed, which is true.
    const deadLetter = new sqs.Queue(this, 'OutboundDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const outbound = new sqs.Queue(this, 'Outbound', {
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: deadLetter, maxReceiveCount: 5 },
    });

    // ── Secrets: the provider key, by NAME ───────────────────────────────────
    const llmKeyArn = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: llmApiKeyParameter.replace(/^\//, ''),
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const readLlmKey = new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [llmKeyArn],
    });

    const commonEnv = {
      BOT_TABLE: table.tableName,
      BOT_OUTBOUND_QUEUE_URL: outbound.queueUrl,
      BOT_SITE_ORIGIN: siteOrigin,
      BOT_LLM_PROVIDER: llmProvider,
      BOT_LLM_MODEL: llmModel,
      BOT_LLM_API_KEY_PARAMETER: llmApiKeyParameter,
    };

    // ── Alerts topic ─────────────────────────────────────────────────────────
    // Same shape as #230's: enforceSSL replaces SNS's default policy, so CloudWatch is
    // named as a publisher explicitly; no SSE (an alarm cannot publish through the managed
    // key, and the payload is an alarm transition carrying nothing about any person).
    const topic = new sns.Topic(this, 'Alerts', { displayName: 'Whippin bot alerts', enforceSSL: true });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarms',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    if (props.operatorEmail) {
      topic.addSubscription(new subscriptions.EmailSubscription(props.operatorEmail));
    }
    const notify = (alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(new cwActions.SnsAction(topic));
      alarm.addOkAction(new cwActions.SnsAction(topic));
    };

    // ── Fargate: the ONE long-lived WhatsApp session ─────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.DISABLED });
    const taskLogs = new logs.LogGroup(this, 'TaskLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer('bot', {
      // Built from the REPO ROOT (the bot inlines @whippin/shared and pnpm resolves the
      // workspace); the root .dockerignore whitelists what the image needs and is what the
      // asset fingerprint honours. amd64 explicitly, so a break-glass deploy from an ARM
      // laptop still builds what Fargate runs.
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: BOT_DOCKERFILE,
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({ logGroup: taskLogs, streamPrefix: 'bot' }),
      environment: {
        ...commonEnv,
        BOT_GROUPS_DIR: '/app/packages/whatsapp-bot/groups/local',
        BOT_METRICS_NAMESPACE: BOT_METRICS_NAMESPACE,
      },
      // Baileys' Signal work is bursty but small; the reservation keeps the scheduler honest.
      memoryReservationMiB: 256,
    });
    table.grantReadWriteData(taskDefinition.taskRole);
    outbound.grantConsumeMessages(taskDefinition.taskRole);
    outbound.grantSendMessages(taskDefinition.taskRole);
    taskDefinition.taskRole.addToPrincipalPolicy(readLlmKey);
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'], // PutMetricData supports no resource-level scoping; the namespace condition is the scope.
        conditions: { StringEquals: { 'cloudwatch:namespace': BOT_METRICS_NAMESPACE } },
      }),
    );

    const securityGroup = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'Whippin WhatsApp bot task: outbound only, no ingress',
      allowAllOutbound: true,
    });
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      // ONE ACTIVE TASK IS A CORRECTNESS RULE: a deploy stops the old task before starting
      // the new one (0% min healthy, 100% max), so two sockets never share the session.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [securityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
    });

    // ── Podium job: Lambda + one schedule per configured group ───────────────
    const podiumLogs = new logs.LogGroup(this, 'PodiumLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const podium = new NodejsFunction(this, 'PodiumJob', {
      entry: PODIUM_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(90),
      logGroup: podiumLogs,
      environment: { ...commonEnv, BOT_GROUPS_DIR: '/var/task/groups' },
      depsLockFilePath: REPO_LOCKFILE,
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        // The pulled snapshot travels with the bundle: the job reads its own config. The
        // bundle's `groups/` directory ALWAYS exists — the runtime loader treats a missing
        // one as a misconfigured BOT_GROUPS_DIR and refuses to run — and an absent
        // snapshot on the synth side copies nothing into it, which is the same empty set
        // the warning above already named (a bare `cp -R` of a missing source would fail
        // the bundle instead, contradicting that tolerance).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => {
            const target = path.join(outputDir, 'groups');
            return [
              `mkdir -p "${target}"`,
              `if [ -d "${groupsDir}" ]; then cp -R "${groupsDir}/." "${target}"; fi`,
            ];
          },
        },
      },
    });
    table.grantReadData(podium);
    outbound.grantSendMessages(podium);
    podium.addToRolePolicy(readLlmKey);

    for (const group of groups) {
      if (!group.podium.enabled) continue;
      const [hour, minute] = group.podium.time.split(':');
      new scheduler.Schedule(this, `Podium${scheduleId(group)}`, {
        description: `Whippin podium for ${group.name} at ${group.podium.time} ${group.podium.timezone}`,
        schedule: scheduler.ScheduleExpression.cron({
          minute: String(Number(minute)),
          hour: String(Number(hour)),
          timeZone: TimeZone.of(group.podium.timezone),
        }),
        target: new LambdaInvoke(podium, {
          input: scheduler.ScheduleTargetInput.fromObject({ group: group.id }),
          retryAttempts: 2,
          maxEventAge: Duration.hours(1),
        }),
      });
    }

    // ── Alarms ───────────────────────────────────────────────────────────────
    // Disconnected: the task's own gauge, missing data BREACHING — a task that is dead,
    // idling unpaired or restart-looping publishes 0 or nothing, and both must wake someone.
    notify(
      new cloudwatch.Alarm(this, 'Disconnected', {
        alarmDescription: 'The Whippin WhatsApp bot has not held a connection for 15 minutes.',
        metric: new cloudwatch.Metric({
          namespace: BOT_METRICS_NAMESPACE,
          metricName: CONNECTED_METRIC,
          statistic: 'Average',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );
    notify(
      new cloudwatch.Alarm(this, 'OutboundDeadLetters', {
        alarmDescription: 'An outbound WhatsApp command (a podium, a reply) could not be delivered.',
        metric: deadLetter.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    notify(
      new cloudwatch.Alarm(this, 'PodiumErrors', {
        alarmDescription: 'The Whippin podium job failed.',
        metric: podium.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // ── cdk-nag: accepted exceptions ─────────────────────────────────────────
    NagSuppressions.addResourceSuppressions(
      taskDefinition,
      [
        {
          id: 'AwsSolutions-ECS2',
          reason:
            'The container environment carries table/queue names, the site origin, the provider and model NAMES and the SSM parameter NAME of the API key — never a secret value; the key is read from Parameter Store at runtime.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'DynamoDB access is scoped to the bot table (the grant\'s index wildcard names a table with no index); SQS to the one outbound queue; ssm:GetParameter to the one exact parameter ARN. cloudwatch:PutMetricData supports no resource-level scoping and is conditioned on the bot\'s own namespace.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      podium,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS-managed basic-execution policy for CloudWatch Logs — the standard least-broad managed policy.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'DynamoDB read scoped to the bot table (index wildcard on a table with no index); SQS send to the one outbound queue; ssm:GetParameter to the one exact parameter ARN.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Runtime pinned to NODEJS_22_X, the current maintained Node LTS on Lambda, for reproducible builds.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(vpc, [
      {
        id: 'AwsSolutions-VPC7',
        reason:
          'No VPC flow logs: the VPC holds one outbound-only task with no ingress rule and no inbound listener; flow logs would cost more than the task and record nothing actionable.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(cluster, [
      {
        id: 'AwsSolutions-ECS4',
        reason:
          'Container Insights intentionally off for one 0.25 vCPU task; the connection gauge + alarm is the observability this service needs.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(service, [
      {
        id: 'AwsSolutions-ECS7',
        reason: 'Logging is configured through the awslogs driver on the container definition.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(deadLetter, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This IS the dead-letter queue.',
      },
    ]);
    // The schedules' generated invoke role: LambdaInvoke grants the function ARN plus its
    // versions (`<arn>:*`) — the standard shape of a Lambda invoke grant.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'The EventBridge Scheduler target role may invoke the podium function and its versions (`<function arn>:*`), which is the standard invoke grant shape.',
        appliesTo: ['Resource::<PodiumJob*.Arn>:*'],
      },
    ]);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new CfnOutput(this, 'BotTableName', {
      description: 'The bot table — set as BOT_TABLE for `pnpm bot:pair` / `pnpm bot:cli`.',
      value: table.tableName,
    });
    new CfnOutput(this, 'OutboundQueueUrl', { value: outbound.queueUrl });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ServiceName', {
      description: 'Scale to 0 before pairing (`aws ecs update-service --desired-count 0`), back to 1 after.',
      value: service.serviceName,
    });
    new CfnOutput(this, 'PodiumFunctionName', {
      description: 'Invoke by hand with {"group": "<jid>", "date": "YYYY-MM-DD"} to replay a podium.',
      value: podium.functionName,
    });
    new CfnOutput(this, 'AlertsTopicArn', { value: topic.topicArn });
    new CfnOutput(this, 'ConfiguredGroups', {
      value: groups.map((g) => `${g.name} (${g.language}${g.podium.enabled ? `, podium ${g.podium.time} ${g.podium.timezone}` : ''})`).join('; ') || 'none',
    });
    void Aws.REGION;
  }
}

function scheduleId(group: GroupConfig): string {
  return group.id.replace(/@g\.us$/, '').replace(/\D/g, '');
}
