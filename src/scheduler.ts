import { loadConfig } from './config.ts';
import { collectDailyNodeResults } from './collection.ts';
import { fetchAllNodes, resolveTargetNodes } from './nodes.ts';
import { sendNotification } from './notify.ts';
import {
  buildDailyReport,
  renderReport,
  shouldSendNotification,
} from './report.ts';
import { loadState, saveState } from './state.ts';
import { getCrossSourceOverlapKey } from './ipqa.ts';
import type { IpqaAlert, NodeCollectionResult } from './types.ts';
import {
  formatBeijingDateKey,
  getBeijingDailyWindow,
  getBeijingParts,
  isBeijingDue,
} from './time.ts';

let running = false;

export interface ServerContext {
  cron: (expression: string, handler: () => Promise<void> | void) => void;
  call: (method: string, params?: unknown) => Promise<unknown>;
  getConfig: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export function alertDeliveryKey(nodeUuid: string, alert: IpqaAlert): string {
  return `alert|${nodeUuid}|${alert.dedupeKey || `${alert.source || 'unknown'}|${alert.raw}`}`;
}

export function failureDeliveryKey(node: NodeCollectionResult): string {
  return `failure|${node.uuid}|${node.status}`;
}

export function alertOverlapDeliveryKey(
  nodeUuid: string,
  alert: IpqaAlert
): string | null {
  const overlapKey = getCrossSourceOverlapKey(alert);
  return overlapKey ? `overlap|${nodeUuid}|${overlapKey}` : null;
}

/**
 * Filters already-delivered items from a catch-up tick.
 *
 * Exact keys handle ordinary retry idempotence. pendingLegacyOverlapKeys only
 * bridges the one transition that exact keys cannot cover: a legacy alerts.log
 * event sent while semantic data was missing, followed by the matching semantic
 * archive alert on a later tick.
 *
 * When that transition is reconciled, the semantic exact key is also recorded
 * and the pending overlap key is consumed, so later semantic retries stay silent
 * without broadly suppressing future events in the same category.
 */
function buildDeliveryResults(
  nodeResults: NodeCollectionResult[],
  sentKeys: Set<string>,
  pendingLegacyOverlapKeys: Set<string>
): NodeCollectionResult[] {
  return nodeResults.map(node => {
    if (node.status === 'OK') {
      return {
        ...node,
        alerts: node.alerts.filter(alert => {
          const exactKey = alertDeliveryKey(node.uuid, alert);
          if (sentKeys.has(exactKey)) {
            return false;
          }

          if (node.semanticAvailable === true && alert.source === 'archive_diff') {
            const overlapKey = alertOverlapDeliveryKey(node.uuid, alert);
            if (overlapKey && pendingLegacyOverlapKeys.has(overlapKey)) {
              // The same business event was already delivered from alerts.log on
              // an earlier tick while semantic data was missing.
              sentKeys.add(exactKey);
              pendingLegacyOverlapKeys.delete(overlapKey);
              return false;
            }
          }

          return true;
        }),
      };
    }

    if (sentKeys.has(failureDeliveryKey(node))) {
      return {
        ...node,
        status: 'OK' as const,
        alerts: [],
      };
    }

    return node;
  });
}

function recordDeliveredItems(
  nodeResults: NodeCollectionResult[],
  notifyCollectionFailures: boolean,
  sentKeys: Set<string>,
  pendingLegacyOverlapKeys: Set<string>
): void {
  for (const node of nodeResults) {
    if (node.status === 'OK') {
      for (const alert of node.alerts) {
        sentKeys.add(alertDeliveryKey(node.uuid, alert));

        if (
          node.semanticAvailable === false &&
          alert.source === 'alerts_log'
        ) {
          const overlapKey = alertOverlapDeliveryKey(node.uuid, alert);
          if (overlapKey) {
            pendingLegacyOverlapKeys.add(overlapKey);
          }
        }
      }
    } else if (notifyCollectionFailures) {
      sentKeys.add(failureDeliveryKey(node));
    }
  }
}

/**
 * Core daily report execution workflow.
 *
 * During the 07:00-07:09 catch-up window, a node that has not produced today's
 * semantic archive does not block alerts from other nodes. The run stays open
 * for another tick, while already-delivered alerts are persisted and suppressed
 * on retries.
 */
export async function runDailyReport(server: ServerContext, now = new Date()): Promise<void> {
  const config = await loadConfig(server);
  if (!config.enabled) {
    return;
  }

  const bj = getBeijingParts(now);
  const dateKey = formatBeijingDateKey(bj);
  const state = loadState();

  if (state.last_run_beijing_date === dateKey) {
    return;
  }

  if (running) {
    console.log('[IPQA] Another run is currently in progress, skipping');
    return;
  }

  running = true;

  try {
    const allNodes = await fetchAllNodes(server);
    const targets = resolveTargetNodes(config, allNodes);

    if (targets.length === 0) {
      console.log('[IPQA] no selected nodes');
      state.last_run_beijing_date = dateKey;
      state.last_success_at = new Date().toISOString();
      state.attempt_count = 0;
      state.daily_delivery = {
        beijing_date: dateKey,
        sent_keys: [],
        pending_legacy_overlap_keys: [],
      };
      state.last_summary = {
        selected_nodes: 0,
        alert_nodes: 0,
        alerts: 0,
        collection_failures: 0,
      };
      saveState(state);
      return;
    }

    console.log(`[IPQA] selected nodes: ${targets.length}`);

    // Sync latest archives and update node-index cache before generating daily report
    if (config.sync_archives) {
      try {
        const { syncIpqaArchives } = await import('./ipqa/archive-sync.ts');
        await syncIpqaArchives(server, { reason: 'pre-report', now });
      } catch (syncErr) {
        console.warn('[IPQA] Pre-report archive sync error during daily run:', syncErr);
      }
    }

    const { startEpoch, endEpoch, windowStart, windowEnd } =
      getBeijingDailyWindow(dateKey);

    const nodeResults = await collectDailyNodeResults({
      server,
      targets,
      config,
      dateKey,
      startEpoch,
      endEpoch,
    });

    if (!state.daily_delivery || state.daily_delivery.beijing_date !== dateKey) {
      state.daily_delivery = {
        beijing_date: dateKey,
        sent_keys: [],
        pending_legacy_overlap_keys: [],
      };
    }

    const sentKeys = new Set(state.daily_delivery.sent_keys);
    const pendingLegacyOverlapKeys = new Set(
      state.daily_delivery.pending_legacy_overlap_keys ?? []
    );
    const deliveryResults = buildDeliveryResults(
      nodeResults,
      sentKeys,
      pendingLegacyOverlapKeys
    );

    // Keep two reports intentionally:
    // - fullReport describes the latest complete snapshot seen on this tick and
    //   is used for persisted summary state.
    // - deliveryReport contains only items not already delivered and is used for
    //   Telegram output.
    const fullReport = buildDailyReport({
      dateKey,
      windowStart,
      windowEnd,
      selectedNodeCount: targets.length,
      nodeResults,
    });
    const deliveryReport = buildDailyReport({
      dateKey,
      windowStart,
      windowEnd,
      selectedNodeCount: targets.length,
      nodeResults: deliveryResults,
    });

    console.log(
      `[IPQA] report: alert_nodes=${fullReport.alertNodeCount} alerts=${fullReport.alertCount} failures=${fullReport.failedNodes.length} pending_delivery=${deliveryReport.alertCount}`
    );

    if (shouldSendNotification(deliveryReport, config)) {
      const message = renderReport(deliveryReport, config);
      await sendNotification(server, message);

      recordDeliveredItems(
        deliveryResults,
        config.notify_collection_failures,
        sentKeys,
        pendingLegacyOverlapKeys
      );
      state.daily_delivery.sent_keys = [...sentKeys];
      state.daily_delivery.pending_legacy_overlap_keys = [
        ...pendingLegacyOverlapKeys,
      ];
      saveState(state);
      console.log('[IPQA] notification sent');
    }

    const missingSemanticNodes =
      config.sync_archives !== false
        ? nodeResults.filter(node => node.semanticAvailable === false)
        : [];

    const canRetryInCurrentWindow =
      bj.hour === 7 && bj.minute >= 0 && bj.minute < 9;

    // Keep the logical day open while any selected node has not produced today's
    // semantic archive. A deliberately paused/stale node may remain missing, but
    // it no longer prevents other nodes' newly-arriving alerts from being sent.
    const retryForLateSemantic =
      missingSemanticNodes.length > 0 && canRetryInCurrentWindow;

    state.last_success_at = new Date().toISOString();
    state.attempt_date = dateKey;
    state.attempt_count = 0;
    // Persist the full latest snapshot, not the incremental delivery delta.
    // Otherwise a quiet later retry would overwrite an earlier successful
    // DataWave/Vmiss delivery with alerts=0.
    state.last_summary = {
      selected_nodes: targets.length,
      alert_nodes: fullReport.alertNodeCount,
      alerts: fullReport.alertCount,
      collection_failures: fullReport.failedNodes.length,
    };

    // Reconciliation can mutate these sets even when no notification is sent.
    // Persist them on the normal end-of-tick save below as well.
    state.daily_delivery.sent_keys = [...sentKeys];
    state.daily_delivery.pending_legacy_overlap_keys = [
      ...pendingLegacyOverlapKeys,
    ];

    if (retryForLateSemantic) {
      state.last_run_beijing_date = '';
      saveState(state);
      console.log(
        `[IPQA] run partial for Beijing date ${dateKey}; waiting for semantic archive from: ${missingSemanticNodes.map(n => n.name).join(', ')}`
      );
      return;
    }

    state.last_run_beijing_date = dateKey;
    saveState(state);

    console.log(`[IPQA] run completed for Beijing date ${dateKey}`);
  } catch (error) {
    console.error('[IPQA] Daily report run failed:', error);
    const currentAttempts =
      state.attempt_date === dateKey ? (state.attempt_count ?? 0) : 0;
    state.attempt_date = dateKey;
    state.attempt_count = currentAttempts + 1;
    saveState(state);
    throw error;
  } finally {
    running = false;
  }
}

/**
 * Scheduler tick triggered every minute by server.cron("* * * * *").
 */
export async function schedulerTick(server: ServerContext, now = new Date()): Promise<void> {
  const bj = getBeijingParts(now);

  // 1. Daily archive sync retry window: 04:10–04:59 Asia/Shanghai, every 5 minutes (Section 13)
  const isInDailySyncWindow =
    bj.hour === 4 && bj.minute >= 10;
  if (isInDailySyncWindow && bj.minute % 5 === 0) {
    try {
      const config = await loadConfig(server);
      if (config.enabled && config.sync_archives) {
        const { syncIpqaArchives } = await import('./ipqa/archive-sync.ts');
        await syncIpqaArchives(server, { reason: 'daily', now });
      }
    } catch (dailySyncErr) {
      console.warn('[IPQA] Daily archive sync encountered error:', dailySyncErr);
    }
  }

  // 2. Daily 07:00 due window (Section 8)
  if (!isBeijingDue(now)) {
    return;
  }

  const dateKey = formatBeijingDateKey(bj);
  const state = loadState();

  if (state.last_run_beijing_date === dateKey) {
    return;
  }

  if (state.attempt_date === dateKey && (state.attempt_count ?? 0) >= 3) {
    return;
  }

  console.log(`[IPQA] scheduler tick: due for ${dateKey}`);
  await runDailyReport(server, now);
}

/**
 * Registers the cron scheduler.
 */
export function registerScheduler(server: ServerContext): void {
  server.cron('* * * * *', async () => {
    try {
      await schedulerTick(server);
    } catch (err) {
      console.error('[IPQA] Scheduled run encountered error:', err);
    }
  });
  console.log('[IPQA] Scheduler registered: checking every minute for Beijing 04:10-04:59 sync and 07:00 report windows');
}
