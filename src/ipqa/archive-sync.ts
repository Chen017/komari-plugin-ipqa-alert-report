import type { KomariNode } from '../types.ts';
import type { ServerContext } from '../scheduler.ts';
import { runRemoteTask } from '../remote.ts';
import { loadConfig } from '../config.ts';
import { fetchAllNodes, resolveTargetNodes } from '../nodes.ts';
import { loadState, saveState } from '../state.ts';
import { formatBeijingDateKey, getBeijingParts } from '../time.ts';
import { buildManifestCommand, parseManifestOutput } from './archive-manifest.ts';
import { buildBatchFetchCommand, parseBatchFetchOutput } from './archive-fetch.ts';
import { getReportRiskCategory, normalizeRawIpqa } from './archive-normalize.ts';
import { pairDailyReports } from './archive-pair.ts';
import { compareDailyReports } from './archive-diff.ts';
import { calculateFreshness } from './freshness.ts';
import {
  getLatestDailyReport,
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
} from './types.ts';

const BATCH_SIZE = 8;
const TASK_TIMEOUT_MS = 25_000;

export interface SyncOptions {
  reason: 'startup' | 'daily' | 'pre-report' | 'manual';
  targetDate?: string;
  selectedNodeUuids?: string[];
  now?: Date;
}

export interface NodeSyncResult {
  uuid: string;
  name: string;
  status: 'updated' | 'already_current' | 'not_installed' | 'offline' | 'failed';
  previousLatestDate?: string | null;
  latestDate?: string | null;
  fetchedArchives: number;
  canonicalDaysUpdated: string[];
  error?: string;
  overview?: IpqaNodeOverview;
}

export interface ArchiveSyncResult {
  reason: string;
  startedAt: string;
  finishedAt: string;
  nodes: NodeSyncResult[];
}

/**
 * Builds protocol summary for v4 or v6 report in node overview.
 */
function buildProtocolSummary(rep: IpqaNormalizedReport | null | undefined) {
  if (!rep) return undefined;
  const scores = rep.scores ?? {};
  const risk = getReportRiskCategory(rep);
  const media: Record<string, any> = {};
  const ai: Record<string, any> = {};
  if (rep.media) {
    for (const [s, data] of Object.entries(rep.media as Record<string, any>)) {
      const status = data?.status;
      const isUnlocked = typeof status === 'string' && (status.includes('解锁') || status.includes('Yes') || status.includes('仅自制'));
      const item = { ...data, unlocked: isUnlocked };
      const sLower = s.toLowerCase();
      if (sLower.includes('chatgpt') || sLower.includes('claude') || sLower.includes('openai')) {
        ai[s] = item;
      } else {
        media[s] = item;
      }
    }
  }
  return {
    date: rep.date ?? null,
    risk: {
      category: risk.category,
      source: risk.source,
    },
    scores,
    media,
    ai,
  };
}

/**
 * Builds an IpqaNodeOverview object from local cache and freshness evaluation.
 */
export function buildNodeOverview(node: KomariNode, lastSyncError?: string | null, now = new Date()): IpqaNodeOverview {
  const v4Files = listCachedRawFilenames(node.uuid, 'v4');
  const v6Files = listCachedRawFilenames(node.uuid, 'v6');
  const hasArchives = v4Files.length > 0 || v6Files.length > 0;
  const latest = getLatestDailyReport(node.uuid);

  const freshness = calculateFreshness({
    now,
    latestDate: latest?.date ?? null,
    hasArchives,
    lastSyncError,
    isInstalled: true,
  });

  return {
    uuid: node.uuid,
    name: node.name,
    status: freshness.status === 'fresh' ? 'ok' : freshness.status,
    freshness,
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
    v4: buildProtocolSummary(latest?.v4),
    v6: buildProtocolSummary(latest?.v6),
  };
}

/**
 * Synchronizes archive files for a single node.
 * Resumable, idempotent, and safe against failures.
 */
export async function syncNodeArchives(
  server: ServerContext,
  node: KomariNode,
  now = new Date()
): Promise<NodeSyncResult> {
  const initialLatest = getLatestDailyReport(node.uuid);
  const previousLatestDate = initialLatest?.date ?? null;

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
      const errorMsg = manifestRes?.error || 'Failed to fetch archive manifest from node';
      const overview = buildNodeOverview(node, errorMsg, now);
      return {
        uuid: node.uuid,
        name: node.name,
        status: 'failed',
        previousLatestDate,
        latestDate: previousLatestDate,
        fetchedArchives: 0,
        canonicalDaysUpdated: [],
        error: errorMsg,
        overview,
      };
    }

    const remoteEntries = parseManifestOutput(manifestRes.stdout);
    if (remoteEntries.length === 0) {
      const overview = buildNodeOverview(node, null, now);
      return {
        uuid: node.uuid,
        name: node.name,
        status: 'already_current',
        previousLatestDate,
        latestDate: previousLatestDate,
        fetchedArchives: 0,
        canonicalDaysUpdated: [],
        overview,
      };
    }

    // 2. Identify missing or updated files
    const missing = remoteEntries.filter(
      entry => !hasRawArchive(node.uuid, entry.ipVersion, entry.filename)
    );

    let fetchedCount = 0;
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
          if (item.rawJson && typeof item.rawJson === 'object') {
            saveRawArchive(node.uuid, item.ipVersion, item.filename, item.rawJson);
            fetchedCount++;
          }
        }
      }
    }

    // 4. Normalize, pair, and compute diffs for all cached files
    rebuildNodeDailyReports(node.uuid);

    const updatedLatest = getLatestDailyReport(node.uuid);
    const latestDate = updatedLatest?.date ?? null;
    const overview = buildNodeOverview(node, null, now);

    const status: NodeSyncResult['status'] = fetchedCount > 0 || latestDate !== previousLatestDate
      ? 'updated'
      : 'already_current';

    return {
      uuid: node.uuid,
      name: node.name,
      status,
      previousLatestDate,
      latestDate,
      fetchedArchives: fetchedCount,
      canonicalDaysUpdated: latestDate ? [latestDate] : [],
      overview,
    };
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[IPQA] Error syncing archives for node ${node.name}:`, errorMsg);
    const overview = buildNodeOverview(node, errorMsg, now);
    return {
      uuid: node.uuid,
      name: node.name,
      status: 'failed',
      previousLatestDate,
      latestDate: previousLatestDate,
      fetchedArchives: 0,
      canonicalDaysUpdated: [],
      error: errorMsg,
      overview,
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
 * Unified, idempotent IPQA archive synchronization service (Section 3).
 * Used by:
 * - 'startup': background backfill after plugin load
 * - 'daily': 04:10-05:30 BJT retry window
 * - 'pre-report': 07:00 BJT before sending Telegram report
 * - 'manual': admin-triggered sync now
 */
export async function syncIpqaArchives(
  server: ServerContext,
  options: SyncOptions
): Promise<ArchiveSyncResult> {
  const now = options.now ?? new Date();
  const bj = getBeijingParts(now);
  const todayDate = formatBeijingDateKey(bj);
  const startedAt = now.toISOString();

  console.log(`[IPQA-SYNC] start reason=${options.reason} beijing_date=${todayDate}`);

  const state = loadState();
  if (!state.archive_sync || state.archive_sync.beijing_date !== todayDate) {
    state.archive_sync = {
      beijing_date: todayDate,
      last_attempt_at: startedAt,
      nodes: {},
    };
  } else {
    state.archive_sync.last_attempt_at = startedAt;
  }

  const config = await loadConfig(server);
  const allNodes = await fetchAllNodes(server);
  let targets = resolveTargetNodes(config, allNodes);

  if (options.selectedNodeUuids && options.selectedNodeUuids.length > 0) {
    targets = targets.filter(n => options.selectedNodeUuids!.includes(n.uuid));
  }

  const nodeResults: NodeSyncResult[] = [];
  const nodeOverviews: IpqaNodeOverview[] = [];

  for (const node of targets) {
    const nodeState = state.archive_sync.nodes[node.uuid];

    // For daily sync: if node is already current for today, skip remote execution
    if (
      options.reason === 'daily' &&
      nodeState?.status === 'current' &&
      nodeState?.latest_date === todayDate
    ) {
      console.log(`[IPQA-SYNC] ${node.name} already current for ${todayDate}`);
      const overview = buildNodeOverview(node, null, now);
      nodeOverviews.push(overview);
      nodeResults.push({
        uuid: node.uuid,
        name: node.name,
        status: 'already_current',
        previousLatestDate: todayDate,
        latestDate: todayDate,
        fetchedArchives: 0,
        canonicalDaysUpdated: [],
        overview,
      });
      continue;
    }

    const res = await syncNodeArchives(server, node, now);
    nodeResults.push(res);
    if (res.overview) {
      nodeOverviews.push(res.overview);
    }

    const attempts = (nodeState?.attempts ?? 0) + 1;
    if (res.status === 'updated' || res.status === 'already_current') {
      const isToday = res.latestDate === todayDate;
      state.archive_sync.nodes[node.uuid] = {
        status: isToday ? 'current' : 'current',
        latest_date: res.latestDate ?? null,
        attempts,
        last_attempt_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        error: null,
      };
      if (res.status === 'updated') {
        console.log(
          `[IPQA-SYNC] ${node.name} updated: ${res.previousLatestDate ?? 'none'} -> ${res.latestDate ?? 'none'} (fetched=${res.fetchedArchives})`
        );
      } else {
        console.log(`[IPQA-SYNC] ${node.name} already current`);
      }
    } else {
      state.archive_sync.nodes[node.uuid] = {
        status: 'failed',
        latest_date: res.latestDate ?? null,
        attempts,
        last_attempt_at: new Date().toISOString(),
        error: res.error ?? 'Unknown error',
      };
      console.warn(`[IPQA-SYNC] ${node.name} failed: ${res.error ?? 'Unknown error'}`);
    }
  }

  // Rebuild fleet overview
  const fleetOverview: IpqaFleetOverview = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    total_nodes: targets.length,
    ipqa_nodes: nodeOverviews.filter(n => n.status === 'ok' || n.status === 'stale' || n.status === 'fresh' || n.status === 'pending_today').length,
    nodes_with_risk: nodeOverviews.filter(n => n.highest_risk.category === 'High' || n.highest_risk.category === 'Critical').length,
    nodes_with_changes_today: nodeOverviews.filter(n => n.changes_today > 0).length,
    latest_archive_date: nodeOverviews
      .map(n => n.latest_date)
      .filter((d): d is string => Boolean(d))
      .sort()
      .reverse()[0] ?? null,
    nodes: nodeOverviews,
  };

  saveFleetOverview(fleetOverview);

  const updatedCount = nodeResults.filter(n => n.status === 'updated').length;
  const currentCount = nodeResults.filter(n => n.status === 'already_current').length;
  const failedCount = nodeResults.filter(n => n.status === 'failed').length;

  if (failedCount === 0) {
    state.archive_sync.last_success_at = new Date().toISOString();
  }
  saveState(state);

  const finishedAt = new Date().toISOString();
  console.log(
    `[IPQA-SYNC] finish reason=${options.reason} updated=${updatedCount} current=${currentCount} failed=${failedCount}`
  );

  return {
    reason: options.reason,
    startedAt,
    finishedAt,
    nodes: nodeResults,
  };
}

/**
 * Backward-compatible fleet sync wrapper.
 */
export async function syncFleetArchives(
  server: ServerContext,
  _nodes?: KomariNode[]
): Promise<void> {
  await syncIpqaArchives(server, { reason: 'manual' });
}
