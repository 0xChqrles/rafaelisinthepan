// The CloudWatch metric the task publishes (`whatsapp/metrics.ts`) and the stack alarms on
// (`infra/lib/bot-stack.ts`, through this package's `./metrics` export). ONE spelling: the
// alarm treats missing data as breaching, so a name that drifted on one side would page for
// a bot that is up. Dependency-free on purpose — infra imports it without the AWS SDK.
export const CONNECTED_METRIC = 'Connected';
