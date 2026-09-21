import type { KomariNode } from '../types.ts';
import type { ServerContext } from '../scheduler.ts';
import { runRemoteTask } from '../remote.ts';
import { buildManifestCommand, parseManifestOutput } from './archive-manifest.ts';
import { buildBatchFetchCommand, parseBatchFetchOutput } from './archive-fetch.ts';
import { normalizeRawIpqa } from './archive-normalize.ts';
import { pairDailyReports } from './archive-pair.ts';
import { compareDailyReports } from './archive-diff.ts';
import {
  hasRawArchive,
  listCachedRawFilenames,
  readRawArchive,
  saveDailyReport,
  saveFleetOverview,
  saveRawArchive,
} from '../storage/archive-store.ts';
import type {
  IpqaFleetOverview,
  IpqaNodeOverview,
  IpqaNormalizedReport,
  NodeIpqaStatus,
} from './types.ts';

const BATCH_SIZE = 8;
const TASK_TIMEOUT_MS = 25_000;

/**
 * Synchronizes archive files for a single node.
 * Resumable and safe against failures.
 */
export async function syncNodeArchives(
  server: ServerContext,
  node: KomariNode
): Promise<{ syncedCount: number; error?: string }> {
  try {
    // 1. Fetch remote manifest
    const manifestCmd = buildManifestCommand();
    const { results: manifestResults } = await runRemoteTask(
      server,
      manifestCmd,
      [node.uuid],
      TASK_TIMEOUT_MS,
      1_000
    );

    const manifestRes = manifestResults.get(node.uuid);
    if (!manifestRes || manifestRes.status === 'TIMEOUT' || !manifestRes.stdout) {
      return {
        syncedCount: 0,
        error: manifestRes?.error || 'Failed to fetch archive manifest from node',
      };
    }

    const remoteEntries = parseManifestOutput(manifestRes.stdout);
    if (remoteEntries.length === 0) {
      return { syncedCount: 0 };
    }

    // 2. Identify missing files
    const missing = remoteEntries.filter(
      entry => !hasRawArchive(node.uuid, entry.ipVersion, entry.filename)
    );

    // 3. Batch download missing files
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const fetchCmd = buildBatchFetchCommand(batch);

      const { results: fetchResults } = await runRemoteTask(
        server,
        fetchCmd,
        [node.uuid],
        TASK_TIMEOUT_MS,
        1_000
      );

      const fetchRes = fetchResults.get(node.uuid);
      if (fetchRes && fetchRes.stdout) {
        const fetched = parseBatchFetchOutput(fetchRes.stdout);
        for (const item of fetched) {
          saveRawArchive(node.uuid, item.ipVersion, item.filename, item.rawJson);
        }
      }
    }

    // 4. Normalize and pair all cached files
    rebuildNodeDailyReports(node.uuid);

    return { syncedCount: missing.length };
  } catch (err: any) {
    console.warn(`[IPQA] Error syncing archives for node ${node.name}:`, err);
    return {
      syncedCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Rebuilds all daily paired reports and diffs for a node from local raw cache.
 */
export function rebuildNodeDailyReports(nodeUuid: string): void {
  const v4Filenames = listCachedRawFilenames(nodeUuid, 'v4');
  const v6Filenames = listCachedRawFilenames(nodeUuid, 'v6');

  const v4Reports: IpqaNormalizedReport[] = [];
  for (const fn of v4Filenames) {
    const raw = readRawArchive(nodeUuid, 'v4', fn);
    if (raw) {
      v4Reports.push(normalizeRawIpqa(raw, 'v4', fn));
    }
  }

  const v6Reports: IpqaNormalizedReport[] = [];
  for (const fn of v6Filenames) {
    const raw = readRawArchive(nodeUuid, 'v6', fn);
    if (raw) {
      v6Reports.push(normalizeRawIpqa(raw, 'v6', fn));
    }
  }

  const dailyReports = pairDailyReports(v4Reports, v6Reports, nodeUuid);

  // Compute changes from previous daily report (dailyReports is sorted newest first)
  // We compare index i with index i + 1 (previous in time)
  for (let i = 0; i < dailyReports.length; i++) {
    const current = dailyReports[i]!;
    const previous = i + 1 < dailyReports.length ? dailyReports[i + 1]! : null;
    current.changesFromPrevious = compareDailyReports(previous, current);
    saveDailyReport(nodeUuid, current);
  }
}

/**
 * Synchronizes all configured nodes and updates the fleet overview.
 */
export async function syncFleetArchives(
  server: ServerContext,
  nodes: KomariNode[]
): Promise<void> {
  console.log(`[IPQA] Starting fleet archive synchronization for ${nodes.length} nodes...`);

  const nodeOverviews: IpqaNodeOverview[] = [];

  for (const node of nodes) {
    const { error } = await syncNodeArchives(server, node);

    const v4Files = listCachedRawFilenames(node.uuid, 'v4');
    const v6Files = listCachedRawFilenames(node.uuid, 'v6');
    const hasArchives = v4Files.length > 0 || v6Files.length > 0;

    let status: NodeIpqaStatus = 'ok';
    if (error) {
      status = hasArchives ? 'stale' : 'collection_error';
    } else if (!hasArchives) {
      status = 'no_archive';
    }

    // Read latest paired report
    const { getLatestDailyReport } = await import('../storage/archive-store.ts');
    const latest = getLatestDailyReport(node.uuid);

    nodeOverviews.push({
      uuid: node.uuid,
      name: node.name,
      status,
      latest_date: latest?.date ?? null,
      has_ipv4: latest?.summary.hasV4 ?? false,
      has_ipv6: latest?.summary.hasV6 ?? false,
      highest_risk: {
        category: latest?.summary.highestRiskCategory ?? 'Unknown',
        source: latest?.summary.highestRiskSource ?? 'None',
      },
      media_summary: latest?.summary.mediaSummary ?? {},
      ai_summary: latest?.summary.aiSummary ?? {},
      changes_today: latest?.changesFromPrevious?.length ?? 0,
    });
  }

  const overview: IpqaFleetOverview = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    total_nodes: nodes.length,
    ipqa_nodes: nodeOverviews.filter(n => n.status === 'ok' || n.status === 'stale').length,
    nodes_with_risk: nodeOverviews.filter(n => n.highest_risk.category === 'High' || n.highest_risk.category === 'Critical').length,
    nodes_with_changes_today: nodeOverviews.filter(n => n.changes_today > 0).length,
    latest_archive_date: nodeOverviews
      .map(n => n.latest_date)
      .filter((d): d is string => Boolean(d))
      .sort()
      .reverse()[0] ?? null,
    nodes: nodeOverviews,
  };

  saveFleetOverview(overview);
  console.log('[IPQA] Fleet archive synchronization completed.');
}
