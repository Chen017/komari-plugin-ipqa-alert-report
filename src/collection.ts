import type {
  IpqaAlert,
  KomariNode,
  NodeCollectionResult,
  NodeCollectionStatus,
  PluginConfig,
  TaskExecResult,
} from './types.ts';
import type { ServerContext } from './scheduler.ts';
import { buildIpqaReadCommand, runRemoteTask } from './remote.ts';
import { filterAlerts, mergeAlerts, parseLegacyTaskResult } from './ipqa.ts';
import { semanticChangesToAlerts } from './ipqa/archive-alerts.ts';
import { getDailyReport } from './storage/archive-store.ts';
import { beijingEpochSeconds } from './time.ts';

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
 * Parses an alert timestamp into epoch seconds (aligned with Beijing time parts).
 */
export function parseAlertEpoch(timestamp: string): number | null {
  const ts = (timestamp || '').trim();
  if (!ts) return null;

  const match = ts.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const d = parseInt(match[3], 10);
    const h = parseInt(match[4], 10);
    const min = parseInt(match[5], 10);
    const s = parseInt(match[6], 10);
    return beijingEpochSeconds(y, m, d, h, min, s);
  }

  return null;
}

/**
 * Checks if an alert falls within the target epoch window [startEpoch, endEpoch].
 * Strictly filters archive_diff alerts with full date-time timestamps.
 * Retains date-only fallback alerts to avoid accidental exclusion.
 */
export function isAlertInsideWindow(
  alert: IpqaAlert,
  startEpoch: number,
  endEpoch: number
): boolean {
  if (alert.source !== 'archive_diff') {
    return true;
  }
  const epoch = parseAlertEpoch(alert.timestamp);
  if (epoch !== null) {
    return epoch >= startEpoch && epoch <= endEpoch;
  }

  return true;
}

interface SemanticNodeSource {
  available: boolean;
  alerts: IpqaAlert[];
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

  // 1. Resolve local semantic source for every node first
  const targetDateKeys = dateKeys && dateKeys.length > 0 ? dateKeys : [dateKey];
  const semanticByNode = new Map<string, SemanticNodeSource>();

  for (const node of targets) {
    let available = false;
    const alerts: IpqaAlert[] = [];
    if (config.sync_archives !== false) {
      for (const dk of targetDateKeys) {
        const dailyReport = getDailyReport(node.uuid, dk);
        if (dailyReport) {
          available = true;
          const rawAlerts = semanticChangesToAlerts(node.uuid, dailyReport);
          for (const alert of rawAlerts) {
            if (isAlertInsideWindow(alert, startEpoch, endEpoch)) {
              alerts.push(alert);
            }
          }
        }
      }
    }
    semanticByNode.set(node.uuid, { available, alerts });
  }

  // 2. Fetch remote alerts.log across nodes (best-effort supplemental)
  const command = buildIpqaReadCommand(startEpoch, endEpoch);
  const targetUuids = targets.map(n => n.uuid);

  let remoteResults = new Map<string, TaskExecResult>();
  let legacyTransportError: Error | null = null;

  try {
    const res = await runRemoteTask(
      server,
      command,
      targetUuids,
      30_000
    );
    remoteResults = res.results;
  } catch (err) {
    legacyTransportError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      `[IPQA] Supplemental alerts.log remote task execution failed: ${legacyTransportError.message}`
    );
  }

  // Check if any target node has primary semantic source available
  const hasAnySemanticAvailable = Array.from(semanticByNode.values()).some(
    s => s.available
  );

  // If no node has primary semantic source available, rethrow to retain global retry/attempt behavior
  if (!hasAnySemanticAvailable && legacyTransportError) {
    throw legacyTransportError;
  }

  const nodeResults: NodeCollectionResult[] = [];

  for (const node of targets) {
    const semantic = semanticByNode.get(node.uuid) || { available: false, alerts: [] };
    const taskResult = remoteResults.get(node.uuid);
    const legacy = legacyTransportError
      ? {
          status: 'EXEC_FAILED' as const,
          alerts: [],
          error: legacyTransportError.message,
          rawCount: 0,
          malformedCount: 0,
        }
      : parseLegacyTaskResult(taskResult);

    // Primary: semantic source available (even with 0 changes, node status is OK)
    if (semantic.available) {
      if (legacy.status !== 'OK') {
        console.warn(
          `[IPQA] ${node.name}: semantic source available; supplemental alerts.log unavailable: ${legacy.status}${legacy.error ? ` (${legacy.error})` : ''}`
        );
      }
      const legacyAlerts = legacy.status === 'OK' ? legacy.alerts : [];
      const mergeRes = mergeAlerts(node.uuid, semantic.alerts, legacyAlerts);
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

    // Fallback: semantic source unavailable -> legacy status governs
    if (legacy.status !== 'OK') {
      console.log(`[IPQA] ${node.name}: ${legacy.status}`);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        weight: node.weight,
        status: legacy.status,
        alerts: [],
        error: legacy.error,
      });
      continue;
    }

    const mergeRes = mergeAlerts(node.uuid, [], legacy.alerts);
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
