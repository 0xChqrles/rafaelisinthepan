// "Alert if the service remains disconnected rather than continuing to claim the bot is
// healthy" (#236). The task publishes ONE gauge — connected 1/0 — once a minute; the stack
// alarms on it with missing data treated as breaching, so a task that is dead, stuck or
// looping through restarts is as loud as one that is up and disconnected.

import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { Log } from '../log';

export const CONNECTED_METRIC = 'Connected';
export const METRIC_INTERVAL_MS = 60_000;

export function startConnectedMetric(
  namespace: string,
  isConnected: () => boolean,
  log: Log,
  client = new CloudWatchClient({}),
): () => void {
  const publish = async () => {
    try {
      await client.send(
        new PutMetricDataCommand({
          Namespace: namespace,
          MetricData: [{ MetricName: CONNECTED_METRIC, Value: isConnected() ? 1 : 0, Unit: 'None' }],
        }),
      );
    } catch (error) {
      log.warn({ event: 'metrics.failed', error: (error as Error).message }, 'metric not published');
    }
  };
  void publish();
  const timer = setInterval(() => void publish(), METRIC_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
