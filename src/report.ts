import type {
  DailyReport,
  IpqaAlert,
  NodeCollectionResult,
  PluginConfig,
} from './types.ts';

export const MAX_REPORT_LENGTH = 3800;

export function getSeverityEmoji(level: string): string {
  const upper = (level || '').toUpperCase().trim();
  switch (upper) {
    case 'CRITICAL':
      return '🔴';
    case 'WARNING':
      return '🟠';
    case 'INFO':
      return '🔵';
    default:
      return '⚪';
  }
}

/**
 * Extracts HH:mm from timestamp string (e.g. "2026-09-21 04:10:02" or "04:10:02" -> "04:10").
 */
export function formatAlertTime(timestamp: string): string {
  const trimmed = timestamp.trim();
  const parts = trimmed.split(/\s+/);
  const timeStr = parts.length >= 2 ? parts[1] : parts[0];
  const timeParts = timeStr.split(':');
  if (timeParts.length >= 2) {
    return `${timeParts[0]}:${timeParts[1]}`;
  }
  return trimmed;
}

/**
 * Builds aggregated DailyReport object from node collection results.
 */
export function buildDailyReport(params: {
  dateKey: string;
  windowStart: string;
  windowEnd: string;
  selectedNodeCount: number;
  nodeResults: NodeCollectionResult[];
}): DailyReport {
  const { dateKey, windowStart, windowEnd, selectedNodeCount, nodeResults } = params;

  const alertNodes = nodeResults.filter(
    n => n.status === 'OK' && n.alerts.length > 0
  );
  const failedNodes = nodeResults.filter(n => n.status !== 'OK');

  let alertCount = 0;
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const node of alertNodes) {
    for (const alert of node.alerts) {
      alertCount++;
      const lvl = alert.level.toUpperCase();
      if (lvl === 'CRITICAL') criticalCount++;
      else if (lvl === 'WARNING') warningCount++;
      else if (lvl === 'INFO') infoCount++;
    }
  }

  return {
    beijingDate: dateKey,
    windowStart,
    windowEnd,
    selectedNodeCount,
    alertNodeCount: alertNodes.length,
    alertCount,
    criticalCount,
    warningCount,
    infoCount,
    alertNodes,
    failedNodes,
  };
}

/**
 * Determines whether a notification should be triggered according to Section 18.
 */
export function shouldSendNotification(
  report: DailyReport,
  config: PluginConfig
): boolean {
  const hasAlerts = report.alertCount > 0;
  const hasFailures = report.failedNodes.length > 0;

  if (!hasAlerts) {
    if (!(config.notify_collection_failures && hasFailures)) {
      return false;
    }
  }

  return true;
}

/**
 * Truncates long message text to a maximum length (default 260 chars).
 */
export function truncateText(text: string, maxLength = 260): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Formats a single node alert entry block.
 */
function renderAlertItem(alert: IpqaAlert): string {
  const emoji = getSeverityEmoji(alert.level);
  const time = formatAlertTime(alert.timestamp);
  const msg = truncateText(alert.message, 260);
  const versionPart = alert.ipVersion ? `${alert.ipVersion} · ` : '';
  return `${emoji} ${versionPart}${time}\n${msg}`;
}

/**
 * Renders the full report into plain text.
 * Implements intelligent progressive truncation (Section 21) to ensure the message never exceeds MAX_REPORT_LENGTH (3800 chars).
 * Never splits into multiple messages!
 */
export function renderReport(report: DailyReport, config: PluginConfig): string {
  let headerText = '';
  if (report.alertCount > 0) {
    headerText = [
      '⚠️ IPQA 每日告警',
      `${report.beijingDate} · 北京时间 07:00`,
      `异常节点：${report.alertNodeCount} / ${report.selectedNodeCount} · 告警：${report.alertCount}`,
      `🔴 ${report.criticalCount}  🟠 ${report.warningCount}  🔵 ${report.infoCount}`,
    ].join('\n');
  } else {
    // Only collection failures (Section 18 Case 3)
    headerText = [
      '⚠️ IPQA 采集异常',
      `${report.beijingDate} · 北京时间 07:00`,
      `异常节点：${report.failedNodes.length} / ${report.selectedNodeCount} · 采集失败：${report.failedNodes.length}`,
    ].join('\n');
  }

  // Build collection failures section if any
  let failureSection = '';
  if (config.notify_collection_failures && report.failedNodes.length > 0) {
    const failureLines = ['━━━━━━━━━━━━━━', '❌ 采集异常', '━━━━━━━━━━━━━━'];
    for (const node of report.failedNodes) {
      failureLines.push(`🖥 ${node.name}`);
      failureLines.push(`无法读取 IPQA 告警：${node.error || node.status}`);
      failureLines.push('');
    }
    failureSection = '\n\n' + failureLines.join('\n').trim();
  }

  // Progressive truncation levels (Section 21):
  // Level 0: all alerts
  // Level 1: Strategy 4 - omit INFO (show '…另有 X 条 INFO 未展开')
  // Level 2: Strategy 5 - omit WARNING (show '…另有 X 条 WARNING 未展开')
  // Level 3: Strategy 9 - keep highest severity summary per node (1st alert per node) and summarize the rest
  function buildAlertBlocks(level: number): string {
    const blocks: string[] = [];
    for (const node of report.alertNodes) {
      const nodeLines = ['━━━━━━━━━━━━━━', `🖥 ${node.name}`, '━━━━━━━━━━━━━━'];

      let hiddenInfoCount = 0;
      let hiddenWarningCount = 0;
      let hiddenCriticalCount = 0;

      for (let i = 0; i < node.alerts.length; i++) {
        const alert = node.alerts[i];
        const lvl = alert.level.toUpperCase();

        if (level >= 3) {
          // Strategy 9: keep the 1st (highest severity) alert for each node, summarize the rest
          if (i > 0) {
            if (lvl === 'CRITICAL') hiddenCriticalCount++;
            else if (lvl === 'WARNING') hiddenWarningCount++;
            else hiddenInfoCount++;
            continue;
          }
        } else {
          if (lvl === 'INFO' && level >= 1) {
            hiddenInfoCount++;
            continue;
          }
          if (lvl === 'WARNING' && level >= 2) {
            hiddenWarningCount++;
            continue;
          }
        }

        nodeLines.push(renderAlertItem(alert));
        nodeLines.push('');
      }

      if (hiddenCriticalCount > 0) {
        nodeLines.push(`…另有 ${hiddenCriticalCount} 条 CRITICAL 未展开`);
      }
      if (hiddenWarningCount > 0) {
        nodeLines.push(`…另有 ${hiddenWarningCount} 条 WARNING 未展开`);
      }
      if (hiddenInfoCount > 0) {
        nodeLines.push(`…另有 ${hiddenInfoCount} 条 INFO 未展开`);
      }

      blocks.push(nodeLines.join('\n').trim());
    }
    return blocks.join('\n\n');
  }

  let alertBody = buildAlertBlocks(0);
  let fullMessage = alertBody
    ? `${headerText}\n\n${alertBody}${failureSection}`
    : `${headerText}${failureSection}`;

  // Strategy 4: Omit INFO first
  if (fullMessage.length > MAX_REPORT_LENGTH) {
    alertBody = buildAlertBlocks(1);
    fullMessage = alertBody
      ? `${headerText}\n\n${alertBody}${failureSection}`
      : `${headerText}${failureSection}`;
  }

  // Strategy 5: Omit WARNING
  if (fullMessage.length > MAX_REPORT_LENGTH) {
    alertBody = buildAlertBlocks(2);
    fullMessage = alertBody
      ? `${headerText}\n\n${alertBody}${failureSection}`
      : `${headerText}${failureSection}`;
  }

  // Strategy 9: If extreme cases still exceed, summarize highest severity per node
  if (fullMessage.length > MAX_REPORT_LENGTH) {
    alertBody = buildAlertBlocks(3);
    fullMessage = alertBody
      ? `${headerText}\n\n${alertBody}${failureSection}`
      : `${headerText}${failureSection}`;
  }

  // Ultimate fallback truncation
  if (fullMessage.length > MAX_REPORT_LENGTH) {
    fullMessage = fullMessage.slice(0, MAX_REPORT_LENGTH - 30) + '\n…(内容过长已截断)';
  }

  // Apply template if customized
  if (config.template && config.template.trim()) {
    const templated = applyTemplate(config.template, report, fullMessage);
    if (templated.length > MAX_REPORT_LENGTH) {
      return templated.slice(0, MAX_REPORT_LENGTH - 30) + '\n…(内容过长已截断)';
    }
    return templated;
  }

  return fullMessage;
}

/**
 * Replaces placeholders in custom template according to Section 23.
 */
export function applyTemplate(
  template: string,
  report: DailyReport,
  defaultMessage: string
): string {
  const replacements: Record<string, string | number> = {
    date: report.beijingDate,
    start: report.windowStart,
    end: report.windowEnd,
    message: defaultMessage,
    nodes: report.selectedNodeCount,
    alert_nodes: report.alertNodeCount,
    alert_count: report.alertCount,
    critical_count: report.criticalCount,
    warning_count: report.warningCount,
    info_count: report.infoCount,
    failed_nodes: report.failedNodes.length,
    event: 'IPQAAlertReport',
    emoji: '⚠️',
    time: '07:00',
  };

  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      return String(replacements[key]);
    }
    return match;
  });
}
