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

    const taskResult = remoteResults.get(node.uuid);
    let legacyAlerts: IpqaAlert[] = [];
    let legacyStatus: NodeCollectionStatus = 'OK';
    let legacyError: string | undefined;

    if (!taskResult) {
      legacyStatus = 'TIMEOUT';
      legacyError = 'No result returned from agent';
    } else if (taskResult.status === 'TIMEOUT') {
      legacyStatus = 'TIMEOUT';
      legacyError = taskResult.error || 'Agent task timeout';
    } else if (taskResult.exit_code !== undefined && taskResult.exit_code !== 0 && !taskResult.stdout) {
      legacyStatus = 'EXEC_FAILED';
      legacyError =
        taskResult.error ||
        taskResult.stderr ||
        `Command exited with code ${taskResult.exit_code}`;
    } else {
      const stdout = (taskResult.stdout || '').trim();
      if (!stdout) {
        legacyStatus = 'PARSE_FAILED';
        legacyError = 'Empty stdout without status header';
      } else {
        const lines = stdout.split(/\r?\n/);
        const firstLine = lines[0].trim();

        if (firstLine.startsWith('__IPQA_STATUS__|')) {
          const statusCode = firstLine.split('|')[1]?.trim();
          if (statusCode === 'OK') {
            legacyStatus = 'OK';
          } else if (statusCode === 'NOT_FOUND') {
            legacyStatus = 'NOT_FOUND';
            legacyError = 'alerts.log not found (~/.ipqa/data/alerts.log)';
          } else if (statusCode === 'DATE_CONVERSION_FAILED') {
            legacyStatus = 'DATE_CONVERSION_FAILED';
            legacyError = 'Failed to convert epoch to local time via date command';
          } else if (statusCode === 'READ_FAILED') {
            legacyStatus = 'EXEC_FAILED';
            legacyError = 'Failed to read alerts.log (permission or I/O error)';
          } else {
            legacyStatus = 'PARSE_FAILED';
            legacyError = `Unknown status header: ${statusCode}`;
          }
        } else {
          legacyStatus = 'PARSE_FAILED';
          legacyError = `Missing __IPQA_STATUS__ header (received: "${firstLine.slice(0, 50)}")`;
        }

        if (legacyStatus === 'OK') {
          const rawAlertLines = lines.slice(1);
          for (const line of rawAlertLines) {
            if (!line.trim()) continue;
            const alert = parseAlertLine(line);
            if (alert) {
              alert.source = 'alerts_log';
              legacyAlerts.push(alert);
            }
          }
        }
      }
    }

    // If semantic alerts exist, supplemental alerts.log failure does NOT block the report
    if (semanticAlerts.length > 0) {
      if (legacyStatus !== 'OK') {
        console.warn(
          `[IPQA] ${node.name}: supplemental alerts.log unavailable (${legacyStatus}: ${legacyError}), proceeding with ${semanticAlerts.length} semantic alert(s)`
        );
      }
      const mergeRes = mergeAlerts(node.uuid, semanticAlerts, legacyAlerts);
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
      continue;
    }

    // No semantic alerts: legacy status governs
    if (legacyStatus !== 'OK') {
      console.log(`[IPQA] ${node.name}: ${legacyStatus}`);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        weight: node.weight,
        status: legacyStatus,
        alerts: [],
        error: legacyError,
      });
      continue;
    }

    const mergeRes = mergeAlerts(node.uuid, [], legacyAlerts);
    const filterRes = filterAlerts(mergeRes.merged, config);

    console.log(
      `[IPQA] ${node.name}: OK semantic=0 legacy_raw=${mergeRes.legacyRawCount} merged=${mergeRes.merged.length} kept=${filterRes.kept} below_severity=${filterRes.below_severity} ignored_initial=${filterRes.ignored_initial} deduplicated=${mergeRes.deduplicatedCount}`
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
