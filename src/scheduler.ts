import { loadConfig } from './config.ts';
import { parseNodeResult } from './ipqa.ts';
import { fetchAllNodes, resolveTargetNodes } from './nodes.ts';
import { sendNotification } from './notify.ts';
import { buildIpqaReadCommand, runRemoteTask } from './remote.ts';
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

    // Sync latest archives and update node-index cache if enabled
    if (config.sync_archives) {
      try {
        const { syncFleetArchives } = await import('./ipqa/archive-sync.ts');
        await syncFleetArchives(server, targets);
      } catch (syncErr) {
        console.warn('[IPQA] Fleet archive sync error during daily run:', syncErr);
      }
    }

    const { startEpoch, endEpoch, windowStart, windowEnd } =
      getBeijingDailyWindow(dateKey);

    const command = buildIpqaReadCommand(startEpoch, endEpoch);
    const targetUuids = targets.map(n => n.uuid);

    const { taskId, results } = await runRemoteTask(
      server,
      command,
      targetUuids,
      30_000
    );

    const nodeResults = targets.map(node =>
      parseNodeResult(node, results.get(node.uuid), config)
    );

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
    state.last_task_id = taskId;
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
  if (!isBeijingDue(now)) {
    return;
  }

  const bj = getBeijingParts(now);
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
  console.log('[IPQA] Scheduler registered: checking every minute for Beijing 07:00 due window');
}
