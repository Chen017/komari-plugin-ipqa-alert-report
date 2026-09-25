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

function buildDeliveryResults(
  nodeResults: NodeCollectionResult[],
  sentKeys: Set<string>
): NodeCollectionResult[] {
  return nodeResults.map(node => {
    if (node.status === 'OK') {
      return {
        ...node,
        alerts: node.alerts.filter(
          alert => !sentKeys.has(alertDeliveryKey(node.uuid, alert))
        ),
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

function collectDeliveredKeys(
  nodeResults: NodeCollectionResult[],
  notifyCollectionFailures: boolean
): string[] {
  const keys: string[] = [];

  for (const node of nodeResults) {
    if (node.status === 'OK') {
      for (const alert of node.alerts) {
        keys.push(alertDeliveryKey(node.uuid, alert));
      }
    } else if (notifyCollectionFailures) {
      keys.push(failureDeliveryKey(node));
    }
  }

  return keys;
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
      };
    }

    const sentKeys = new Set(state.daily_delivery.sent_keys);
    const deliveryResults = buildDeliveryResults(nodeResults, sentKeys);
    const report = buildDailyReport({
      dateKey,
      windowStart,
      windowEnd,
      selectedNodeCount: targets.length,
      nodeResults: deliveryResults,
    });

    console.log(
      `[IPQA] report: alert_nodes=${report.alertNodeCount} alerts=${report.alertCount} failures=${report.failedNodes.length}`
    );

    if (shouldSendNotification(report, config)) {
      const message = renderReport(report, config);
      await sendNotification(server, message);

      for (const key of collectDeliveredKeys(
        deliveryResults,
        config.notify_collection_failures
      )) {
        sentKeys.add(key);
      }
      state.daily_delivery.sent_keys = [...sentKeys];
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
    state.last_summary = {
      selected_nodes: targets.length,
      alert_nodes: report.alertNodeCount,
      alerts: report.alertCount,
      collection_failures: report.failedNodes.length,
    };

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
