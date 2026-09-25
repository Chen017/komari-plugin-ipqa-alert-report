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

export interface CollectDailyNodeResultsParams {
  server: ServerContext;
  targets: KomariNode[];
  config: PluginConfig;
  dateKey: string;
  startEpoch: number;
  endEpoch: number;
  includeSemantic?: boolean;
}

interface SemanticNodeSource {
  available: boolean;
  alerts: IpqaAlert[];
}

/**
 * Collects and processes alerts for all target nodes:
 * 1. Reads local paired archive reports for the scheduled logical date (semantic diffs).
 * 2. Fetches remote alerts.log across nodes in parallel (best-effort supplemental).
 * 3. Merges semantic changes with supplemental legacy alerts.
 * 4. Deduplicates overlapping events.
 * 5. Applies unified severity and initial archive filtering.
 */
export async function collectDailyNodeResults(
  params: CollectDailyNodeResultsParams
): Promise<NodeCollectionResult[]> {
  const {
    server,
    targets,
    config,
    dateKey,
    startEpoch,
    endEpoch,
    includeSemantic = true,
  } = params;

  if (targets.length === 0) {
    return [];
  }

  // 1. Resolve local semantic source for every node first
  const semanticByNode = new Map<string, SemanticNodeSource>();

  for (const node of targets) {
    let available = false;
    let alerts: IpqaAlert[] = [];
    if (includeSemantic && config.sync_archives !== false) {
      const dailyReport = getDailyReport(node.uuid, dateKey);
      if (dailyReport) {
        available = true;
        alerts = semanticChangesToAlerts(node.uuid, dailyReport);
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
