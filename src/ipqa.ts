import type {
  IpqaAlert,
  KomariNode,
  NodeCollectionResult,
  NodeCollectionStatus,
  PluginConfig,
  Severity,
  TaskExecResult,
} from './types.ts';

export const SEVERITY_RANKS: Record<string, number> = {
  CRITICAL: 3,
  WARNING: 2,
  INFO: 1,
};

export function getSeverityRank(level: string): number {
  const upper = (level || '').toUpperCase().trim();
  return SEVERITY_RANKS[upper] ?? 0;
}

const ALERT_LINE_REGEX_4 = /^([^|]+)\|([^|]+)\|(.*)\|([^|]+)$/;
const ALERT_LINE_REGEX_3 = /^([^|]+)\|([^|]+)\|(.*)$/;

/**
 * Parses a single raw alert line from alerts.log.
 * Format: timestamp|level|message|ip_version (or timestamp|level|message)
 */
export function parseAlertLine(line: string): IpqaAlert | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match4 = trimmed.match(ALERT_LINE_REGEX_4);
  if (match4) {
    const [, timestamp, level, message, ipVersion] = match4;
    return {
      timestamp: timestamp.trim(),
      level: level.trim().toUpperCase(),
      message: message.trim(),
      ipVersion: ipVersion.trim(),
      raw: trimmed,
    };
  }

  const match3 = trimmed.match(ALERT_LINE_REGEX_3);
  if (match3) {
    const [, timestamp, level, message] = match3;
    return {
      timestamp: timestamp.trim(),
      level: level.trim().toUpperCase(),
      message: message.trim(),
      ipVersion: '',
      raw: trimmed,
    };
  }

  return null;
}

/**
 * Parses and filters node task results according to protocol and configuration.
 * Error isolation: Each node is parsed independently without throwing.
 */
export function parseNodeResult(
  node: KomariNode,
  taskResult: TaskExecResult | undefined,
  config: PluginConfig
): NodeCollectionResult {
  if (!taskResult) {
    console.log(`[IPQA] ${node.name}: TIMEOUT`);
    return {
      uuid: node.uuid,
      name: node.name,
      weight: node.weight,
      status: 'TIMEOUT',
      alerts: [],
      error: 'No result returned from agent',
    };
  }

  if (taskResult.status === 'TIMEOUT') {
    console.log(`[IPQA] ${node.name}: TIMEOUT`);
    return {
      uuid: node.uuid,
      name: node.name,
      weight: node.weight,
      status: 'TIMEOUT',
      alerts: [],
      error: taskResult.error || 'Agent task timeout',
    };
  }

  if (taskResult.exit_code !== undefined && taskResult.exit_code !== 0 && !taskResult.stdout) {
    console.log(`[IPQA] ${node.name}: EXEC_FAILED`);
    return {
      uuid: node.uuid,
      name: node.name,
      weight: node.weight,
      status: 'EXEC_FAILED',
      alerts: [],
      error: taskResult.error || taskResult.stderr || `Command exited with code ${taskResult.exit_code}`,
    };
  }

  const stdout = (taskResult.stdout || '').trim();
  if (!stdout) {
    console.log(`[IPQA] ${node.name}: PARSE_FAILED`);
    return {
      uuid: node.uuid,
      name: node.name,
      weight: node.weight,
      status: 'PARSE_FAILED',
      alerts: [],
      error: 'Empty stdout without status header',
    };
  }

  const lines = stdout.split(/\r?\n/);
  const firstLine = lines[0].trim();

  let status: NodeCollectionStatus = 'OK';
  let errorMsg: string | undefined;

  if (firstLine.startsWith('__IPQA_STATUS__|')) {
    const statusCode = firstLine.split('|')[1]?.trim();
    if (statusCode === 'OK') {
      status = 'OK';
    } else if (statusCode === 'NOT_FOUND') {
      status = 'NOT_FOUND';
      errorMsg = 'alerts.log not found (~/.ipqa/data/alerts.log)';
    } else if (statusCode === 'DATE_CONVERSION_FAILED') {
      status = 'DATE_CONVERSION_FAILED';
      errorMsg = 'Failed to convert epoch to local time via date command';
    } else if (statusCode === 'READ_FAILED') {
      status = 'EXEC_FAILED';
      errorMsg = 'Failed to read alerts.log (permission or I/O error)';
    } else {
      status = 'PARSE_FAILED';
      errorMsg = `Unknown status header: ${statusCode}`;
    }
  } else {
    status = 'PARSE_FAILED';
    errorMsg = `Missing __IPQA_STATUS__ header (received: "${firstLine.slice(0, 50)}")`;
  }

  if (status !== 'OK') {
    console.log(`[IPQA] ${node.name}: ${status}`);
    return {
      uuid: node.uuid,
      name: node.name,
      weight: node.weight,
      status,
      alerts: [],
      error: errorMsg,
    };
  }

  // Parse remaining lines
  const rawAlertLines = lines.slice(1);
  const minRank = getSeverityRank(config.min_severity);
  const seenRaw = new Set<string>();
  const alerts: IpqaAlert[] = [];

  for (const line of rawAlertLines) {
    if (!line.trim()) continue;

    const alert = parseAlertLine(line);
    if (!alert) {
      console.warn(`[IPQA] ${node.name}: Malformed alert line: "${line}"`);
      continue;
    }

    // 1. Ignore initial archive if enabled
    if (
      config.ignore_initial_archive &&
      alert.message.includes('首次完成数据存档监测')
    ) {
      continue;
    }

    // 2. Filter by minimum severity
    if (getSeverityRank(alert.level) < minRank) {
      continue;
    }

    // 3. Deduplicate identical raw lines within the same node
    if (seenRaw.has(alert.raw)) {
      continue;
    }
    seenRaw.add(alert.raw);

    alerts.push(alert);
  }

  // Sort by severity rank descending (CRITICAL -> WARNING -> INFO), then timestamp ascending
  alerts.sort((a, b) => {
    const rankDiff = getSeverityRank(b.level) - getSeverityRank(a.level);
    if (rankDiff !== 0) return rankDiff;
    return a.timestamp.localeCompare(b.timestamp);
  });

  console.log(
    `[IPQA] ${node.name}: OK, raw=${rawAlertLines.length}, filtered=${alerts.length}`
  );

  return {
    uuid: node.uuid,
    name: node.name,
    weight: node.weight,
    status: 'OK',
    alerts,
  };
}
