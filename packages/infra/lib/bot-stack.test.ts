import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { App, Aspects } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { BotStack, BOT_METRICS_NAMESPACE } from './bot-stack';

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const KEY_PARAMETER = '/test/bot-llm-key';
const GROUP = '120363000000000001@g.us';

function groupsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whippin-groups-'));
  writeFileSync(
    join(dir, 'fr.json'),
    JSON.stringify({
      id: GROUP,
      name: 'Whippin FR',
      language: 'fr',
      enabled: true,
      podium: { enabled: true, time: '22:00', timezone: 'Europe/Paris' },
      reminder: { enabled: true, time: '09:00' },
      chat: { enabled: true, prePrompt: 'x' },
    }),
  );
  writeFileSync(
    join(dir, 'off.json'),
    JSON.stringify({
      id: '120363000000000002@g.us',
      name: 'Off',
      language: 'en',
      enabled: false,
      podium: { enabled: true, time: '21:30', timezone: 'Europe/London' },
      chat: { enabled: false },
    }),
  );
  return dir;
}

function botTemplate(): Template {
  // Skip asset bundling: the template is what this test reads, and the Lambda bundle
  // (esbuild via the package manager) is the deploy's business, not the assertions'.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new BotStack(app, 'TestBotStack', {
    env: { account: ACCOUNT, region: REGION },
    llmApiKeyParameter: KEY_PARAMETER,
    operatorEmail: 'ops@test.invalid',
    groupsDir: groupsDir(),
  });
  return Template.fromStack(stack);
}

const template = botTemplate();

describe('WhatsApp bot stack (#236)', () => {
  it('runs exactly one task, stop-before-start, public IP, no ingress, no NAT', () => {
    const services = Object.values(template.findResources('AWS::ECS::Service'));
    expect(services).toHaveLength(1);
    const props = services[0].Properties;
    expect(props.DesiredCount).toBe(1);
    expect(props.DeploymentConfiguration).toMatchObject({
      MinimumHealthyPercent: 0,
      MaximumPercent: 100,
    });
    expect(props.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('ENABLED');
    expect(template.findResources('AWS::EC2::NatGateway')).toEqual({});
    expect(template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')).toEqual({});
    const sgs = Object.values(template.findResources('AWS::EC2::SecurityGroup'));
    for (const sg of sgs) expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
  });

  it('keeps secrets out of the environment: parameter NAMES only, read at runtime', () => {
    const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    expect(tasks).toHaveLength(1);
    const env = tasks[0].Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    const byName = Object.fromEntries(env.map((e) => [e.Name, e.Value]));
    expect(byName.BOT_LLM_API_KEY_PARAMETER).toBe(KEY_PARAMETER);
    expect(byName.BOT_LLM_PROVIDER).toBe('deepseek');
    expect(byName.BOT_LLM_MODEL).toBe('deepseek-v4-flash');
    expect(byName.BOT_METRICS_NAMESPACE).toBe(BOT_METRICS_NAMESPACE);
    expect(byName).not.toHaveProperty('BOT_LLM_API_KEY');
    expect(tasks[0].Properties.ContainerDefinitions[0].Secrets).toBeUndefined();

    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    const ssm = statements.filter((s) => s.Action === 'ssm:GetParameter');
    expect(ssm.length).toBeGreaterThanOrEqual(2);
    for (const s of ssm) {
      expect(JSON.stringify(s.Resource)).toContain(`:ssm:${REGION}:${ACCOUNT}:parameter/test/bot-llm-key`);
    }
  });

  it('creates a podium schedule and a reminder schedule per ENABLED group, at its zone, on ONE job', () => {
    const schedules = Object.values(template.findResources('AWS::Scheduler::Schedule')).map((s) => s.Properties);
    expect(schedules).toHaveLength(2);
    const byInput = new Map(schedules.map((p) => [JSON.stringify(JSON.parse(p.Target.Input)), p]));
    const podium = byInput.get(JSON.stringify({ group: GROUP }));
    const reminder = byInput.get(JSON.stringify({ group: GROUP, kind: 'reminder' }));
    expect(podium?.ScheduleExpression).toBe('cron(0 22 * * ? *)');
    expect(reminder?.ScheduleExpression).toBe('cron(0 9 * * ? *)');
    for (const p of schedules) expect(p.ScheduleExpressionTimezone).toBe('Europe/Paris');
    expect(Object.values(template.findResources('AWS::Lambda::Function'))).toHaveLength(1);
  });

  it('owns a table with TTL + PITR, an outbound queue with a DLQ, and alarms that treat silence as down', () => {
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table'));
    expect(tables).toHaveLength(1);
    expect(tables[0].Properties.TimeToLiveSpecification.AttributeName).toBe('expiresAt');
    expect(tables[0].Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(tables[0].DeletionPolicy).toBe('Retain');
    expect(Object.values(template.findResources('AWS::SQS::Queue'))).toHaveLength(2);

    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    const disconnected = alarms.find((a) => a.Properties.MetricName === 'Connected');
    expect(disconnected?.Properties).toMatchObject({
      Namespace: BOT_METRICS_NAMESPACE,
      TreatMissingData: 'breaching',
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 3,
    });
    expect(Object.values(template.findResources('AWS::SNS::Subscription'))).toHaveLength(1);
  });

  // THE SUITE HAS TO RUN cdk-nag, because `bin/app.ts` does and a finding there is a
  // FAILED SYNTH — a deploy that dies before it starts. It was not run here, and that is
  // how a suppression whose `appliesTo` used `*` as a glob (cdk-nag compares a plain
  // string with `===`) reached production. It was invisible twice over: the finding needs
  // a SCHEDULE, a schedule needs an ENABLED GROUP, and the snapshot this stack reads is
  // gitignored — so every CI synth until the first real group in SSM had nothing to check.
  it('synthesizes with NO cdk-nag findings, with a real group configured', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new BotStack(app, 'NagBotStack', {
      env: { account: ACCOUNT, region: REGION },
      llmApiKeyParameter: KEY_PARAMETER,
      operatorEmail: 'ops@test.invalid',
      groupsDir: groupsDir(),
    });
    Aspects.of(app).add(new AwsSolutionsChecks());
    expect(
      Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
    ).toEqual([]);
  });
});

describe('the podium Lambda BUNDLE, not just its template (2026-09-04 outage)', () => {
  // THE TEMPLATE CANNOT SEE THIS BUG, and the test above deliberately skips bundling —
  // "the deploy's business, not the assertions'" — so nothing loaded the Lambda until a
  // schedule loaded it in production. pino requires `node:os` at load; esbuild's ESM
  // output replaces a `require` it cannot resolve with a stub that THROWS, so the
  // function died in INIT on every invocation. Both schedules fired at 22:00, all six
  // attempts failed, and the only visible symptom was a group that got no podium.
  // `scripts/bundle.mjs` had carried the createRequire banner for the TASK all along.
  it('loads under Node ESM, with a working require for its CommonJS dependencies', async () => {
    const app = new App(); // bundling ON, unlike botTemplate() above
    new BotStack(app, 'BundledBotStack', {
      env: { account: ACCOUNT, region: REGION },
      llmApiKeyParameter: KEY_PARAMETER,
      operatorEmail: 'ops@test.invalid',
      groupsDir: groupsDir(),
    });
    const asm = app.synth();
    // The podium asset is the one carrying the group snapshot its handler reads.
    const bundles = readdirSync(asm.directory)
      .map((entry) => join(asm.directory, entry, 'index.mjs'))
      .filter((file) => existsSync(file) && existsSync(join(dirname(file), 'groups')));
    expect(bundles).toHaveLength(1);

    // IN A REAL NODE ESM PROCESS, NOT THIS ONE. Vitest's module runner puts a `require`
    // in scope, and esbuild's stub checks `typeof require !== "undefined"` before it
    // throws — so importing the bundle here SUCCEEDS even when the banner is missing, and
    // the test could never fail. (Verified: banner removed, cdk.out wiped, still green.)
    // Loaded from INSIDE the bot package, where `@aws-sdk/*` resolves — it is external to
    // the bundle, exactly as in the Lambda, whose runtime provides it.
    const probe = join(__dirname, '..', '..', 'whatsapp-bot', `bundle-probe-${process.pid}.mjs`);
    try {
      copyFileSync(bundles[0], probe);
      const out = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(probe).href)}); if (typeof m.handler !== 'function') { throw new Error('no handler export'); } console.log('ok');`],
        { encoding: 'utf8' },
      );
      expect(`${out.stdout}${out.stderr}`.trim()).toContain('ok');
      expect(out.status).toBe(0);
    } finally {
      rmSync(probe, { force: true });
    }
  }, 120_000);
});
