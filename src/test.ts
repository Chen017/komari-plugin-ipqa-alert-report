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
import type { ServerContext } from './scheduler.ts';
import {
  beijingEpochSeconds,
  formatBeijingDateKey,
  getBeijingDailyWindow,
  getBeijingParts,
} from './time.ts';
import type { DailyReport, NodeCollectionResult } from './types.ts';

export type TestTimeWindow = 'today_now' | 'today_0700' | 'last_24h';

export interface TestRunOptions {
  window?: TestTimeWindow;
  forceSend?: boolean;
}

export interface TestRunResult {
  success: boolean;
  message: string;
  window: {
    start: string;
    end: string;
    startEpoch: number;
    endEpoch: number;
  };
  selectedNodes: number;
  alertNodes: number;
  alertCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  failedNodes: Array<{ name: string; status: string; error?: string }>;
  nodeResults: Array<{
    name: string;
    uuid: string;
    status: string;
    alertCount: number;
    error?: string;
  }>;
  notificationSent: boolean;
  notificationSkippedReason?: string;
  renderedMessage?: string;
  report?: DailyReport;
}

/**
 * Calculates test query time window based on selected mode.
 */
export function getTestWindow(
  mode: TestTimeWindow = 'today_now',
  now: Date = new Date()
): {
  dateKey: string;
  startEpoch: number;
  endEpoch: number;
  windowStart: string;
  windowEnd: string;
} {
  const bj = getBeijingParts(now);
  const dateKey = formatBeijingDateKey(bj);

  if (mode === 'today_0700') {
    return {
      dateKey,
      ...getBeijingDailyWindow(dateKey),
    };
  }

  if (mode === 'last_24h') {
    const endEpoch = Math.floor(now.getTime() / 1000);
    const startEpoch = endEpoch - 24 * 60 * 60;
    const startBj = getBeijingParts(new Date(startEpoch * 1000));
    const endBj = getBeijingParts(now);

    const pad = (n: number) => n.toString().padStart(2, '0');
    return {
      dateKey,
      startEpoch,
      endEpoch,
      windowStart: `${startBj.year}-${pad(startBj.month)}-${pad(startBj.day)} ${pad(startBj.hour)}:${pad(startBj.minute)}:${pad(startBj.second)}`,
      windowEnd: `${endBj.year}-${pad(endBj.month)}-${pad(endBj.day)} ${pad(endBj.hour)}:${pad(endBj.minute)}:${pad(endBj.second)}`,
    };
  }

  // Default: 'today_now' - From today 00:00:00 to now (or at least 07:00:59)
  const [yearStr, monthStr, dayStr] = dateKey.split('-');
  const y = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  const startEpoch = beijingEpochSeconds(y, m, d, 0, 0, 0);
  const currentEpoch = Math.floor(now.getTime() / 1000);
  const standard0700Epoch = beijingEpochSeconds(y, m, d, 7, 0, 59);
  const endEpoch = Math.max(currentEpoch, standard0700Epoch);

  const endBj = getBeijingParts(new Date(endEpoch * 1000));
  const pad = (n: number) => n.toString().padStart(2, '0');

  return {
    dateKey,
    startEpoch,
    endEpoch,
    windowStart: `${dateKey} 00:00:00`,
    windowEnd: `${endBj.year}-${pad(endBj.month)}-${pad(endBj.day)} ${pad(endBj.hour)}:${pad(endBj.minute)}:${pad(endBj.second)}`,
  };
}

/**
 * Executes a manual test run:
 * 1. Reads current configuration (regardless of enabled switch).
 * 2. Connects to VPS nodes and fetches alerts.log.
 * 3. Parses and filters alerts according to rules.
 * 4. Sends notification if rules are met (or forceSend is true).
 * 5. Does NOT mutate daily scheduled run state (state.last_run_beijing_date).
 */
export async function runTestReport(
  server: ServerContext,
  options: TestRunOptions = {},
  now: Date = new Date()
): Promise<TestRunResult> {
  console.log('[IPQA-TEST] Starting manual test run...');
  const config = await loadConfig(server);

  const allNodes = await fetchAllNodes(server);
  const targets = resolveTargetNodes(config, allNodes);

  const { dateKey, startEpoch, endEpoch, windowStart, windowEnd } =
    getTestWindow(options.window, now);

  const windowInfo = {
    start: windowStart,
    end: windowEnd,
    startEpoch,
    endEpoch,
  };

  if (targets.length === 0) {
    return {
      success: false,
      message:
        '未找到任何目标节点。请先在插件设置中选择节点，或开启“为全部节点启用”。',
      window: windowInfo,
      selectedNodes: 0,
      alertNodes: 0,
      alertCount: 0,
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      failedNodes: [],
      nodeResults: [],
      notificationSent: false,
      notificationSkippedReason: '无目标节点',
    };
  }

  console.log(
    `[IPQA-TEST] Target nodes: ${targets.length} (${targets.map(t => t.name).join(', ')})`
  );
  console.log(`[IPQA-TEST] Query window: ${windowStart} -> ${windowEnd}`);

  const command = buildIpqaReadCommand(startEpoch, endEpoch);
  const targetUuids = targets.map(n => n.uuid);

  const { results } = await runRemoteTask(
    server,
    command,
    targetUuids,
    30_000
  );

  const nodeResults: NodeCollectionResult[] = targets.map(node =>
    parseNodeResult(node, results.get(node.uuid), config)
  );

  const report = buildDailyReport({
    dateKey,
    windowStart,
    windowEnd,
    selectedNodeCount: targets.length,
    nodeResults,
  });

  const shouldSend = options.forceSend || shouldSendNotification(report, config);
  const renderedMessage = renderReport(report, config);

  let notificationSent = false;
  let notificationSkippedReason: string | undefined;

  if (shouldSend) {
    try {
      await sendNotification(server, renderedMessage);
      notificationSent = true;
      console.log('[IPQA-TEST] Notification sent successfully');
    } catch (err) {
      console.error('[IPQA-TEST] Failed to send notification:', err);
      throw new Error(
        `通知发送失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    notificationSkippedReason =
      '无告警且无采集异常（按照规则不发送空报告）。如需测试通知通道，可勾选“强制发送通知”。';
    console.log(`[IPQA-TEST] Notification skipped: ${notificationSkippedReason}`);
  }

  let summaryMsg = `测试完成：成功采集 ${targets.length} 个节点，共发现 ${report.alertCount} 条告警`;
  if (report.criticalCount > 0 || report.warningCount > 0 || report.infoCount > 0) {
    summaryMsg += `（🔴 ${report.criticalCount} 🟠 ${report.warningCount} 🔵 ${report.infoCount}）`;
  }
  if (report.failedNodes.length > 0) {
    summaryMsg += `，${report.failedNodes.length} 个节点采集异常`;
  }
  if (notificationSent) {
    summaryMsg += '，已按照规则发送告警通知！';
  } else {
    summaryMsg += '，按照规则未触发告警通知。';
  }

  return {
    success: true,
    message: summaryMsg,
    window: windowInfo,
    selectedNodes: targets.length,
    alertNodes: report.alertNodeCount,
    alertCount: report.alertCount,
    criticalCount: report.criticalCount,
    warningCount: report.warningCount,
    infoCount: report.infoCount,
    failedNodes: report.failedNodes.map(n => ({
      name: n.name,
      status: n.status,
      error: n.error,
    })),
    nodeResults: nodeResults.map(n => ({
      name: n.name,
      uuid: n.uuid,
      status: n.status,
      alertCount: n.alerts.length,
      error: n.error,
    })),
    notificationSent,
    notificationSkippedReason,
    renderedMessage,
    report,
  };
}
