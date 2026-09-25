import type {
  IpqaAlert,
  KomariNode,
  NodeCollectionResult,
  NodeCollectionStatus,
  PluginConfig,
} from './types.ts';
import type { ServerContext } from './scheduler.ts';
import { buildIpqaReadCommand, runRemoteTask } from './remote.ts';
import { filterAlerts, mergeAlerts, parseAlertLine } from './ipqa.ts';
import { semanticChangesToAlerts } from './ipqa/archive-alerts.ts';
import { getDailyReport } from './storage/archive-store.ts';

export interface CollectDailyNodeResultsParams {
  server: ServerContext;
  targets: KomariNode[];
  config: PluginConfig;
  dateKey: string;
  startEpoch: number;
  endEpoch: number;
  dateKeys?: string[];
}

/**
 * Collects and processes alerts for all target nodes:
 * 1. Fetches remote alerts.log across nodes in parallel.
 * 2. Reads local paired archive reports for the date window (semantic diffs).
 * 3. Merges semantic changes with supplemental legacy alerts.
 * 4. Deduplicates overlapping events.
 * 5. Applies unified severity and initial archive filtering.
 */
export async function collectDailyNodeResults(
  params: CollectDailyNodeResultsParams
): Promise<NodeCollectionResult[]> {
  const { server, targets, config, dateKey, startEpoch, endEpoch, dateKeys } = params;

  if (targets.length === 0) {
    return [];
  }

  const command = buildIpqaReadCommand(startEpoch, endEpoch);
  const targetUuids = targets.map(n => n.uuid);

  const { results: remoteResults } = await runRemoteTask(
    server,
    command,
    targetUuids,
    30_000
  );

  const targetDateKeys = dateKeys && dateKeys.length > 0 ? dateKeys : [dateKey];
  const nodeResults: NodeCollectionResult[] = [];

  for (const node of targets) {
    const taskResult = remoteResults.get(node.uuid);

    if (!taskResult) {
      console.log(`[IPQA] ${node.name}: TIMEOUT`);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        weight: node.weight,
        status: 'TIMEOUT',
        alerts: [],
        error: 'No result returned from agent',
      });
      continue;
    }

    if (taskResult.status === 'TIMEOUT') {
      console.log(`[IPQA] ${node.name}: TIMEOUT`);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        weight: node.weight,
        status: 'TIMEOUT',
        alerts: [],
        error: taskResult.error || 'Agent task timeout',
      });
      continue;
    }

    if (taskResult.exit_code !== undefined && taskResult.exit_code !== 0 && !taskResult.stdout) {
      console.log(`[IPQA] ${node.name}: EXEC_FAILED`);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        weight: node.weight,
        status: 'EXEC_FAILED',
        alerts: [],
        error:
          taskResult.error ||
          taskResult.stderr ||
          `Command exited with code ${taskResult.exit_code}`,
      });
      continue;
    }

    const stdout = (taskResult.stdout || '').trim();
    if (!stdout) {
      console.log(`[IPQA] ${node.name}: PARSE_FAILED`);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        weight: node.weight,
        status: 'PARSE_FAILED',
        alerts: [],
        error: 'Empty stdout without status header',
      });
      continue;
    }

    const lines = stdout.split(/\r?\n/);
    const firstLine = lines[0].trim();

    let nodeStatus: NodeCollectionStatus = 'OK';
    let errorMsg: string | undefined;

    if (firstLine.startsWith('__IPQA_STATUS__|')) {
      const statusCode = firstLine.split('|')[1]?.trim();
      if (statusCode === 'OK') {
        nodeStatus = 'OK';
      } else if (statusCode === 'NOT_FOUND') {
        nodeStatus = 'NOT_FOUND';
        errorMsg = 'alerts.log not found (~/.ipqa/data/alerts.log)';
      } else if (statusCode === 'DATE_CONVERSION_FAILED') {
        nodeStatus = 'DATE_CONVERSION_FAILED';
        errorMsg = 'Failed to convert epoch to local time via date command';
      } else if (statusCode === 'READ_FAILED') {
        nodeStatus = 'EXEC_FAILED';
        errorMsg = 'Failed to read alerts.log (permission or I/O error)';
      } else {
        nodeStatus = 'PARSE_FAILED';
        errorMsg = `Unknown status header: ${statusCode}`;
      }
    } else {
      nodeStatus = 'PARSE_FAILED';
      errorMsg = `Missing __IPQA_STATUS__ header (received: "${firstLine.slice(0, 50)}")`;
    }

    if (nodeStatus !== 'OK') {
      console.log(`[IPQA] ${node.name}: ${nodeStatus}`);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        weight: node.weight,
        status: nodeStatus,
        alerts: [],
        error: errorMsg,
      });
      continue;
    }

    // Parse raw alert lines from alerts.log
    const rawAlertLines = lines.slice(1);
    const rawLegacyAlerts: IpqaAlert[] = [];
    for (const line of rawAlertLines) {
      if (!line.trim()) continue;
      const alert = parseAlertLine(line);
      if (alert) {
        alert.source = 'alerts_log';
        rawLegacyAlerts.push(alert);
      }
    }

    // Primary: Gather semantic changes from local daily reports
    const semanticAlerts: IpqaAlert[] = [];
    if (config.sync_archives !== false) {
      for (const dk of targetDateKeys) {
        const dailyReport = getDailyReport(node.uuid, dk);
        if (dailyReport) {
          semanticAlerts.push(...semanticChangesToAlerts(node.uuid, dailyReport));
        }
      }
    }

    // Merge and deduplicate
    const mergeRes = mergeAlerts(node.uuid, semanticAlerts, rawLegacyAlerts);

    // Filter by severity and ignore_initial_archive
    const filterRes = filterAlerts(mergeRes.merged, config);

    console.log(
      `[IPQA] ${node.name}: OK semantic=${mergeRes.semanticCount} legacy_raw=${mergeRes.legacyRawCount} merged=${mergeRes.merged.length} kept=${filterRes.kept} below_severity=${filterRes.below_severity} ignored_initial=${filterRes.ignored_initial} deduplicated=${mergeRes.deduplicatedCount}`
    );

    nodeResults.push({
      uuid: node.uuid,
      name: node.name,
      weight: node.weight,
      status: 'OK',
      alerts: filterRes.alerts,
    });
  }

  return nodeResults;
}
