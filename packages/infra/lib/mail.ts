// Mail plumbing (#230). #204 made this game SEND mail; nothing handled what came BACK.
// Two constructs, both hung off `BackendStack`'s existing SES domain identity and its hosted
// zone, and both gated on ONE operator address (`-c operatorEmail=`) — because every part of
// this is a way of REACHING A HUMAN, and there is no version of it worth building that ends
// nowhere. An alarm with no subscription and an MX with no reader are the same bug as the one
// this file exists to fix.
//
//   MailAlerts     — the SNS topic + confirmed subscription, and the two AWS/SES reputation
//                    alarms behind it. Tells us a bounce problem exists.
//   MailReceiving  — the MX, the receipt rule set and a forwarder, so `hello@<domain>` is a
//                    real address. Tells us WHAT bounced, and lets a player write to us.
//
// **What belongs in CDK and what belongs to the operator** follows #204's split, recorded in
// the root AGENTS.md: records that BELONG TO THE IDENTITY this stack owns are in the stack
// (the DKIM CNAMEs there, the MX here — it names the receiver these very resources provision,
// and a receipt rule set with no MX in front of it receives nothing). Records that state the
// DOMAIN'S MAIL POLICY — SPF and DMARC — stay the operator's, published by hand, because they
// are a statement about every sender of this domain and not something this stack may silently
// overwrite. See packages/infra/README.md for the runbook.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/infra/lib
const FORWARDER_ENTRY = path.resolve(here, '..', '..', 'backend', 'src', 'mailForward.ts');
const REPO_LOCKFILE = path.resolve(here, '..', '..', '..', 'pnpm-lock.yaml');

// AWS puts an account "under review" at these rates and can pause its sending above them, so
// they are the thresholds worth waking someone for rather than numbers of our own choosing.
// (They are FRACTIONS: the CloudWatch metric reports 0.05, not 5.)
export const BOUNCE_RATE_THRESHOLD = 0.05;
export const COMPLAINT_RATE_THRESHOLD = 0.001;

// How long a received message sits in S3 before the lifecycle rule deletes it. It is a TRANSIT
// BUFFER, not an archive — the forward happens within seconds and Lambda retries a failure on
// its own — but it is the only copy that survives a forwarder that is broken rather than slow,
// so it has to outlive the time it takes a human to notice the alarm below and go looking.
// The privacy notice states this number; changing it changes that file (root AGENTS.md).
export const INBOUND_RETENTION_DAYS = 30;

// The message SES stores can be up to its own 40 MB receiving cap, which is far more than the
// forwarder should pull into memory or hand back to SES. Above this it forwards a NOTICE
// naming the sender, the subject and the S3 key instead of the message — see mailForward.ts.
export const MAX_FORWARD_BYTES = 9 * 1024 * 1024;

// Where the receipt rule writes, and where the forwarder reads. One prefix, so the bucket
// policy SES gets is scoped to it rather than to the whole bucket.
export const INBOUND_PREFIX = 'inbound/';

export interface MailAlertsProps {
  // The address every alarm notification goes to. SNS emails it a subscription confirmation
  // on first deploy, and NOTHING is delivered until a human clicks it — which is exactly why
  // this construct is worth more than the alarms alone.
  readonly operatorEmail: string;
}

/**
 * The SNS topic operational mail alerts land on, and the two account-level SES reputation
 * alarms behind it (#230). AWS/SES publishes `Reputation.*` without a configuration set, so
 * these need nothing on the sending path.
 */
export class MailAlerts extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MailAlertsProps) {
    super(scope, id);

    // NOT server-side encrypted, deliberately. A CloudWatch alarm cannot publish to an
    // SSE-enabled topic through the AWS-managed `alias/aws/sns` key — that key's policy
    // cannot be edited to grant `cloudwatch.amazonaws.com`, so the alarm silently fails to
    // notify, which is precisely the failure this construct exists to remove. A customer
    // managed key would work and costs $1/month to protect a payload that is a CloudWatch
    // alarm state transition and carries nothing about any player. `enforceSSL` still pins
    // every publisher to TLS.
    this.topic = new sns.Topic(this, 'Topic', {
      displayName: 'Whippin mail alerts',
      enforceSSL: true,
    });
    this.topic.addSubscription(new subscriptions.EmailSubscription(props.operatorEmail));

    // NAME THE PUBLISHER. `enforceSSL` attaches an explicit topic policy, and an explicit
    // policy REPLACES the default one SNS would otherwise apply — the one that allows the
    // owning account. What is left is a lone Deny, and the question of whether an alarm can
    // still publish becomes a question about implicit service grants. This is the one thing
    // in this file that must not be a question, so the grant is written down: CloudWatch,
    // this account, publish only.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarms',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
      }),
    );

    // Reputation metrics are account-wide and dimensionless. MAXIMUM over an hour rather than
    // Average: the question is whether the rate ever crossed the line AWS acts on, and an
    // average would smooth exactly the spike that matters. Missing data is NOT breaching —
    // SES publishes nothing while the account is not sending, and an alarm that goes off
    // because the game was quiet teaches its reader to ignore it.
    const reputation = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName,
        statistic: 'Maximum',
        period: Duration.hours(1),
      });

    const alarm = (id: string, metricName: string, threshold: number, description: string) => {
      const created = new cloudwatch.Alarm(this, id, {
        metric: reputation(metricName),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      created.addAlarmAction(new cwActions.SnsAction(this.topic));
      // The recovery matters as much as the breach: a reputation rate falls slowly, so
      // "it is back under the line" is a fact a human otherwise has to go and look up.
      created.addOkAction(new cwActions.SnsAction(this.topic));
      return created;
    };

    alarm(
      'BounceRate',
      'Reputation.BounceRate',
      BOUNCE_RATE_THRESHOLD,
      `SES bounce rate is over ${BOUNCE_RATE_THRESHOLD * 100}% — AWS reviews accounts at this rate and can pause sending. Account codes stop arriving if it does.`,
    );
    alarm(
      'ComplaintRate',
      'Reputation.ComplaintRate',
      COMPLAINT_RATE_THRESHOLD,
      `SES complaint rate is over ${COMPLAINT_RATE_THRESHOLD * 100}% — AWS reviews accounts at this rate and can pause sending.`,
    );
  }

  /** Alarm on a Lambda's own errors, onto this same topic. */
  addFunctionErrorAlarm(id: string, fn: lambda.IFunction, description: string): cloudwatch.Alarm {
    const created = new cloudwatch.Alarm(this, id, {
      metric: fn.metricErrors({ period: Duration.minutes(15), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: description,
    });
    created.addAlarmAction(new cwActions.SnsAction(this.topic));
    return created;
  }
}

export interface MailReceivingProps {
  // The apex whose Route53 zone this stack already looks up. Both the MX and the well-known
  // aliases hang off it.
  readonly domainName: string;
  readonly zone: route53.IPublicHostedZone;
  // The verified sender #204's codes go out as (`hello@<domain>`). It is also the FIRST
  // address this rule set receives for, which is what makes a reply to a code mail land
  // somewhere, and what gives SES's own bounce forwarding a destination that exists: with no
  // Return-Path set, SES forwards bounce and complaint notifications to the From address.
  readonly mailFrom: string;
  // Where received mail is forwarded. The operator's real inbox.
  readonly forwardTo: string;
  // Errors in the forwarder are alarmed onto this topic — a mail that arrives and is then
  // dropped in silence is the same failure as one that never arrives.
  readonly alerts: MailAlerts;
}

/**
 * Inbound mail for the domain (#230): the MX, the S3 landing bucket, the receipt rule set and
 * the Lambda that forwards what arrives to a human. `hello@` stops bouncing (the privacy
 * notice tells players to write there), `abuse@`/`postmaster@` exist because mailbox
 * providers expect them, and `dmarc@` gives a `rua=` somewhere to point — the aggregate
 * reports are how we would learn our mail is being rejected somewhere, and pointing `rua` at
 * an off-domain mailbox needs an authorization record only THAT domain's owner can publish.
 */
export class MailReceiving extends Construct {
  readonly bucket: s3.Bucket;
  readonly forwarder: NodejsFunction;
  readonly recipients: string[];

  constructor(scope: Construct, id: string, props: MailReceivingProps) {
    super(scope, id);
    const stack = Stack.of(this);

    // SES receiving is REGIONAL and only offered in some regions; this stack is pinned to
    // us-east-1 (bin/app.ts), which is one of them. The MX has to name the endpoint of the
    // region whose rule set is active, so it is derived from the stack rather than written
    // out — a stack moved to a region with no SES receiving fails at deploy, not at the
    // first message.
    const inboundHost = `inbound-smtp.${stack.region}.amazonaws.com`;
    new route53.MxRecord(this, 'Mx', {
      zone: props.zone,
      // Apex: `recordName` omitted means the zone's own name.
      values: [{ priority: 10, hostName: inboundHost }],
      ttl: Duration.minutes(30),
      comment: 'Inbound mail -> SES receiving (#230)',
    });

    // The landing bucket. Private, TLS-enforced, encrypted, and DESTROY rather than RETAIN:
    // this holds other people's mail, so a teardown that ORPHANED it would leave personal
    // correspondence in an account nothing is managing any more. The lifecycle rule is the
    // real retention story — see INBOUND_RETENTION_DAYS.
    this.bucket = new s3.Bucket(this, 'InboundBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          prefix: INBOUND_PREFIX,
          expiration: Duration.days(INBOUND_RETENTION_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const logGroup = new logs.LogGroup(this, 'ForwarderLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.forwarder = new NodejsFunction(this, 'Forwarder', {
      entry: FORWARDER_ENTRY,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Room to hold one message (capped at MAX_FORWARD_BYTES) plus its rewritten copy.
      memorySize: 512,
      timeout: Duration.seconds(30),
      // Inbound mail to four aliases on a small domain is a trickle; the ceiling is here so a
      // mail flood cannot become a compute bill.
      reservedConcurrentExecutions: 5,
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        MAIL_BUCKET: this.bucket.bucketName,
        MAIL_PREFIX: INBOUND_PREFIX,
        MAIL_FROM: props.mailFrom,
        MAIL_FORWARD_TO: props.forwardTo,
        MAX_FORWARD_BYTES: String(MAX_FORWARD_BYTES),
        // The oversize notice tells the reader how long the copy it points at survives.
        // Passed rather than restated, so moving the lifecycle moves the sentence with it.
        MAIL_RETENTION_DAYS: String(INBOUND_RETENTION_DAYS),
      },
      depsLockFilePath: REPO_LOCKFILE,
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    this.bucket.grantRead(this.forwarder, `${INBOUND_PREFIX}*`);
    // The SAME scoping the code sender gets: this stack's own identity, and conditioned on
    // the ONE address it may send as. A forwarder that could send as anything would be a
    // better open relay than the thing it replaces.
    this.forwarder.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          stack.formatArn({ service: 'ses', resource: 'identity', resourceName: props.domainName }),
          stack.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: '*' }),
        ],
        conditions: { StringEquals: { 'ses:FromAddress': props.mailFrom } },
      }),
    );

    // The aliases this domain answers on. ENUMERATED, never a catch-all: a domain that
    // accepts every local part is a spam magnet, and each of these four is here for a stated
    // reason (see the class comment). Deduplicated so a `mailSender` of "abuse" cannot
    // produce a rule SES rejects for repeating a recipient.
    this.recipients = [
      ...new Set([
        props.mailFrom,
        `abuse@${props.domainName}`,
        `postmaster@${props.domainName}`,
        `dmarc@${props.domainName}`,
      ]),
    ];

    const ruleSet = new ses.ReceiptRuleSet(this, 'RuleSet', {
      rules: [
        {
          recipients: this.recipients,
          // Spam and virus scanning on, so the forwarder can refuse to relay what SES already
          // judged (it reads the verdicts off the event).
          scanEnabled: true,
          // Opportunistic TLS. REQUIRE would bounce senders with no STARTTLS, and the point
          // of this address is that mail from anyone reaches a human.
          tlsPolicy: ses.TlsPolicy.OPTIONAL,
          // ORDER MATTERS: SES runs actions in sequence, so the message is in S3 before the
          // forwarder is invoked to read it.
          actions: [
            new sesActions.S3({ bucket: this.bucket, objectKeyPrefix: INBOUND_PREFIX }),
            new sesActions.Lambda({
              function: this.forwarder,
              // Asynchronous: this Lambda makes no mail-flow decision, so SES must not wait
              // on it — and a slow forward must never turn into a bounce for the sender.
              invocationType: sesActions.LambdaInvocationType.EVENT,
            }),
          ],
        },
      ],
    });

    // **A RULE SET THAT IS NOT ACTIVE RECEIVES NOTHING**, and SES holds exactly ONE active
    // rule set per region per account — there is no CloudFormation property for it, only the
    // `SetActiveReceiptRuleSet` API. Left as a documented by-hand step, a complete deploy
    // would still silently receive no mail, which is the shape of bug this whole issue is
    // about. So it is a custom resource: the deploy either activates or fails.
    //
    // It TAKES OVER the region's single active rule set. This account has no other, and the
    // teardown deactivates rather than leaving a rule set pointing at a deleted bucket.
    const activation = new AwsCustomResource(this, 'ActivateRuleSet', {
      onCreate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: PhysicalResourceId.of(`active-rule-set-${stack.region}`),
      },
      onUpdate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: PhysicalResourceId.of(`active-rule-set-${stack.region}`),
      },
      onDelete: {
        // No RuleSetName disables whatever is active — which on this account is ours.
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {},
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          // Both are account-level operations with no resource to name — SES models the
          // active rule set as regional account state, not as a resource ARN.
          actions: ['ses:SetActiveReceiptRuleSet', 'ses:DescribeActiveReceiptRuleSet'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    activation.node.addDependency(ruleSet);

    props.alerts.addFunctionErrorAlarm(
      'ForwarderErrors',
      this.forwarder,
      `Inbound mail to ${props.domainName} arrived but could not be forwarded. The message is in the landing bucket for ${INBOUND_RETENTION_DAYS} days; after that it is gone.`,
    );

    // ── cdk-nag: accepted exceptions (each justified) ─────────────────────────
    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'S3 server access logging intentionally off (the chosen observability tier is Lambda log retention + X-Ray + the alarms in this file). The bucket is private (BLOCK_ALL), TLS-enforced, and read by one function under one prefix.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(
      this.forwarder,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWS-managed basic-execution + X-Ray-write policies — the standard least-broad managed policies for CloudWatch Logs and active tracing.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            "S3 read is scoped to the inbound prefix of this construct's own bucket. ses:SendEmail names this stack's own domain identity and is additionally conditioned on the single ses:FromAddress it may send as; the configuration-set wildcard is required by SES on every SendEmail call and grants nothing on its own.",
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Runtime is pinned to NODEJS_22_X — the current maintained Node LTS on Lambda — for reproducible builds; we deliberately pin a specific LTS rather than a floating "latest". cdk-nag\'s bundled runtime list lags new LTS releases.',
        },
      ],
      true, // also the function's generated role/policy
    );
    // CDK FRAMEWORK-AUTHORED HELPERS. Two of them come with the choices above: the bucket's
    // auto-delete handler, and the shared SDK-call provider behind the rule-set activation.
    // Their runtime and their wildcard permissions belong to the library, not to this file.
    // One sits under this construct; the others are singletons hung off the STACK, shared
    // with anything else that asked for the same helper — so each is suppressed where it
    // actually sits. Looked up rather than named by a literal path: a CDK version that stops
    // emitting one must not fail synth on a suppression with nothing to suppress, while one
    // that RENAMES it surfaces as a loud nag error at synth rather than as silence.
    const frameworkHelper = [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'CDK framework-authored helper; it uses the AWS managed basic-execution policy.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          "CDK framework-authored helper. The rule-set activation calls ses:SetActiveReceiptRuleSet, which AWS models as regional account state with no resource ARN to name; the auto-delete handler's wildcard is scoped to the buckets that opted into auto-deletion — here, this construct's own inbound bucket.",
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK framework-authored helper; its runtime is chosen by the library, not here.',
      },
    ];
    const suppressHelper = (scope: Construct, id: string) => {
      const helper = scope.node.tryFindChild(id);
      if (helper) NagSuppressions.addResourceSuppressions(helper, frameworkHelper, true);
    };
    suppressHelper(this, 'ActivateRuleSet');
    suppressHelper(stack, 'Custom::S3AutoDeleteObjectsCustomResourceProvider');
    // `AwsCustomResource`'s shared SDK-call provider singleton.
    suppressHelper(stack, 'AWS679f53fac002430cb0da5b7982bd2287');
  }
}
