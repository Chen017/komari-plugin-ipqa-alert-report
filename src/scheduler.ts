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

/**
 * Core daily report execution workflow.
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

    const report = buildDailyReport({
      dateKey,
      windowStart,
      windowEnd,
      selectedNodeCount: targets.length,
      nodeResults,
    });

    console.log(
      `[IPQA] report: alert_nodes=${report.alertNodeCount} alerts=${report.alertCount} failures=${report.failedNodes.length}`
    );

    if (shouldSendNotification(report, config)) {
      const message = renderReport(report, config);
      await sendNotification(server, message);
      console.log('[IPQA] notification sent');
    }

    // Persist completed state
    state.last_run_beijing_date = dateKey;
    state.last_success_at = new Date().toISOString();
    state.attempt_date = dateKey;
    state.attempt_count = 0;
    state.last_summary = {
      selected_nodes: targets.length,
      alert_nodes: report.alertNodeCount,
      alerts: report.alertCount,
      collection_failures: report.failedNodes.length,
    };
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
