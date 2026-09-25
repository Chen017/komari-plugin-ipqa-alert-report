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
 * Canonicalizes provider, service, or entity names for strict deduplication.
 * Strips punctuation, spaces, converts to lowercase, and maps aliases.
 */
export function canonicalEntityKey(raw: string): string {
  const trimmed = (raw || '').trim().toLowerCase();
  const normalized = trimmed.replace(/[\s\-_+.]/g, '');
  const ALIAS_MAP: Record<string, string> = {
    dbip: 'dbip',
    'db-ip': 'dbip',
    ipqs: 'ipqs',
    ipqualityscore: 'ipqs',
    amazonpv: 'amazonprimevideo',
    amazonprimevideo: 'amazonprimevideo',
    'disney+': 'disneyplus',
    disneyplus: 'disneyplus',
    youtube: 'youtube',
    ip2location: 'ip2location',
  };
  return ALIAS_MAP[trimmed] || ALIAS_MAP[normalized] || normalized;
}

export interface ClassifiedLegacyAlert {
  category:
    | 'score'
    | 'media_status'
    | 'media_region'
    | 'type'
    | 'factor'
    | 'expected_region'
    | 'dnsbl'
    | 'initial_archive'
    | 'unknown';
  typeKind?: 'info_type' | 'usage_type' | 'company_type';
  providerOrService?: string;
  factorEngine?: string;
  factorName?: string;
  isSupplemental: boolean;
}

/**
 * Lightweight classification of legacy alerts.log lines for semantic deduplication.
 */
export function classifyLegacyAlertForDedupe(alert: IpqaAlert): ClassifiedLegacyAlert {
  const msg = alert.message || '';

  // 3-field legacy lines without ipVersion cannot be reliably matched against semantic diffs
  if (!alert.ipVersion) {
    return { category: 'unknown', isSupplemental: true };
  }

  if (msg.includes('首次完成数据存档监测')) {
    return { category: 'initial_archive', isSupplemental: false };
  }

  if (msg.includes('不符合预期')) {
    return { category: 'expected_region', isSupplemental: true };
  }

  if (msg.includes('DNS 黑名单') || msg.includes('DNSBL')) {
    return { category: 'dnsbl', isSupplemental: false };
  }

  // Score
  if (msg.includes('风险等级')) {
    const scoreMatch = msg.match(
      /(IPQualityScore|IPQS|DB-IP|DBIP|ipapi|scamalytics|IP2LOCATION|ipdata|abuseipdb|ipregistry|cloudflare)/i
    );
    return {
      category: 'score',
      providerOrService: scoreMatch
        ? canonicalEntityKey(scoreMatch[1])
        : undefined,
      isSupplemental: !scoreMatch,
    };
  }

  // Media status
  if (msg.includes('解锁状态')) {
    const mediaMatch = msg.match(/^(.*?)\s*解锁状态/);
    return {
      category: 'media_status',
      providerOrService: mediaMatch
        ? canonicalEntityKey(mediaMatch[1])
        : undefined,
      isSupplemental: !mediaMatch,
    };
  }

  // Media region
  if (msg.includes('地区变动')) {
    const regMatch = msg.match(/^(.*?)\s*地区变动/);
    return {
      category: 'media_region',
      providerOrService: regMatch
        ? canonicalEntityKey(regMatch[1])
        : undefined,
      isSupplemental: !regMatch,
    };
  }

  // Type: only info_type (原生/广播类型) is eligible for deduplication against semantic info.type
  if (msg.includes('原生/广播类型')) {
    return { category: 'type', typeKind: 'info_type', isSupplemental: false };
  }
  if (msg.includes('使用类型属性变更为') || msg.includes('使用类型')) {
    return { category: 'type', typeKind: 'usage_type', isSupplemental: true };
  }
  if (msg.includes('公司类型属性变更为') || msg.includes('公司类型')) {
    return { category: 'type', typeKind: 'company_type', isSupplemental: true };
  }

  // Factor
  if (msg.includes('检出') && msg.includes('因子')) {
    const factorMatch = msg.match(
      /(?:新增风险标记[:：]\s*|风险标记解除[:：]\s*)?(\S+?)\s*(?:检出|不再检出)\s*(\S+?)\s*因子/
    );
    if (factorMatch) {
      return {
        category: 'factor',
        factorEngine: canonicalEntityKey(factorMatch[1]),
        factorName: canonicalEntityKey(factorMatch[2]),
        isSupplemental: false,
      };
    }
    return { category: 'factor', isSupplemental: true };
  }

  return { category: 'unknown', isSupplemental: true };
}

export interface MergeAlertsResult {
  merged: IpqaAlert[];
  semanticCount: number;
  legacyRawCount: number;
  deduplicatedCount: number;
}

/**
 * Merges primary semantic diff alerts with supplemental legacy alerts.
 * Semantic diffs take priority; overlapping legacy lines are suppressed.
 */
export function mergeAlerts(
  _nodeUuid: string,
  semanticAlerts: IpqaAlert[],
  rawLegacyAlerts: IpqaAlert[]
): MergeAlertsResult {
  const semanticCount = semanticAlerts.length;
  const legacyRawCount = rawLegacyAlerts.length;
  let deduplicatedCount = 0;

  // Deduplicate semantic alerts by dedupeKey or raw
  const seenSemantic = new Set<string>();
  const cleanSemanticAlerts: IpqaAlert[] = [];
  for (const a of semanticAlerts) {
    const key = a.dedupeKey || a.raw;
    if (seenSemantic.has(key)) {
      deduplicatedCount++;
      continue;
    }
    seenSemantic.add(key);
    cleanSemanticAlerts.push(a);
  }

  // Catalog semantic changes for suppression of overlapping legacy alerts
  const semanticCoverage: Array<{
    ipVersion: string;
    category: string;
    typeKind?: 'info_type' | 'usage_type' | 'company_type';
    providerOrService?: string;
    factorEngine?: string;
    factorName?: string;
  }> = [];

  for (const sa of cleanSemanticAlerts) {
    if (!sa.dedupeKey) continue;
    const parts = sa.dedupeKey.split('|');
    // Format: ${nodeUuid}|${ipVersion}|${category}|${field}|${before}|${after}
    if (parts.length >= 4) {
      const ipVersion = parts[1];
      const category = parts[2];
      const field = parts[3];

      let normCategory = category;
      let providerOrService: string | undefined;
      let typeKind: 'info_type' | 'usage_type' | 'company_type' | undefined;
      let factorEngine: string | undefined;
      let factorName: string | undefined;

      if (category === 'score') {
        normCategory = 'score';
        if (field.startsWith('scores.')) {
          providerOrService = canonicalEntityKey(field.slice(7));
        }
      } else if (category === 'media') {
        if (field.endsWith('.status')) {
          normCategory = 'media_status';
          providerOrService = canonicalEntityKey(field.slice(6, -7));
        } else if (field.endsWith('.region')) {
          normCategory = 'media_region';
          providerOrService = canonicalEntityKey(field.slice(6, -7));
        }
      } else if (category === 'type') {
        normCategory = 'type';
        if (field === 'info.type') {
          typeKind = 'info_type';
        }
      } else if (category === 'factor') {
        normCategory = 'factor';
        const fParts = field.split('.');
        if (fParts.length >= 3) {
          factorName = canonicalEntityKey(fParts[1]);
          factorEngine = canonicalEntityKey(fParts[2]);
        }
      }

      semanticCoverage.push({
        ipVersion,
        category: normCategory,
        typeKind,
        providerOrService,
        factorEngine,
        factorName,
      });
    }
  }

  // Process legacy alerts
  const seenLegacyRaw = new Set<string>();
  const keptLegacyAlerts: IpqaAlert[] = [];

  for (const la of rawLegacyAlerts) {
    // 1. Raw deduplication for identical lines
    if (seenLegacyRaw.has(la.raw)) {
      deduplicatedCount++;
      continue;
    }
    seenLegacyRaw.add(la.raw);

    // 2. 3-field legacy lines without ipVersion are ambiguous, never suppressed
    if (!la.ipVersion) {
      keptLegacyAlerts.push(la);
      continue;
    }

    // 3. Classify
    const classified = classifyLegacyAlertForDedupe(la);

    // 4. Supplemental events are never suppressed
    if (classified.isSupplemental) {
      keptLegacyAlerts.push(la);
      continue;
    }

    // 5. Overlap suppression check (exact canonical matching)
    const isOverlapped = semanticCoverage.some(sc => {
      if (sc.ipVersion !== la.ipVersion) {
        return false;
      }
      if (sc.category !== classified.category) {
        return false;
      }
      if (classified.category === 'type') {
        return Boolean(
          classified.typeKind === 'info_type' &&
          sc.typeKind === 'info_type'
        );
      }
      if (classified.category === 'factor') {
        if (!classified.factorName || !classified.factorEngine || !sc.factorName || !sc.factorEngine) {
          return false;
        }
        return (
          sc.factorName === classified.factorName &&
          sc.factorEngine === classified.factorEngine
        );
      }
      if (classified.category === 'dnsbl') {
        return true;
      }
      if (classified.providerOrService && sc.providerOrService) {
        return sc.providerOrService === classified.providerOrService;
      }
      return false;
    });

    if (isOverlapped) {
      deduplicatedCount++;
    } else {
      keptLegacyAlerts.push(la);
    }
  }

  const merged = [...cleanSemanticAlerts, ...keptLegacyAlerts];
  return {
    merged,
    semanticCount,
    legacyRawCount,
    deduplicatedCount,
  };
}

export interface FilterAlertsResult {
  alerts: IpqaAlert[];
  kept: number;
  below_severity: number;
  ignored_initial: number;
}

/**
 * Unified severity and initial archive filtering helper.
 */
export function filterAlerts(
  alerts: IpqaAlert[],
  config: PluginConfig
): FilterAlertsResult {
  const minRank = getSeverityRank(config.min_severity);
  let below_severity = 0;
  let ignored_initial = 0;
  const result: IpqaAlert[] = [];

  for (const alert of alerts) {
    if (
      config.ignore_initial_archive &&
      alert.message.includes('首次完成数据存档监测')
    ) {
      ignored_initial++;
      continue;
    }

    if (getSeverityRank(alert.level) < minRank) {
      below_severity++;
      continue;
    }

    result.push(alert);
  }

  // Sort by severity rank descending (CRITICAL -> WARNING -> INFO), then timestamp ascending
  result.sort((a, b) => {
    const rankDiff = getSeverityRank(b.level) - getSeverityRank(a.level);
    if (rankDiff !== 0) return rankDiff;
    return a.timestamp.localeCompare(b.timestamp);
  });

  return {
    alerts: result,
    kept: result.length,
    below_severity,
    ignored_initial,
  };
}

export interface LegacyParseResult {
  status: NodeCollectionStatus;
  alerts: IpqaAlert[];
  error?: string;
  rawCount: number;
  malformedCount: number;
}

/**
 * Parses remote task execution output for alerts.log.
 * Extracts status headers, validates protocol, and parses raw alert lines.
 */
export function parseLegacyTaskResult(
  taskResult: TaskExecResult | undefined
): LegacyParseResult {
  if (!taskResult) {
    return {
      status: 'TIMEOUT',
      alerts: [],
      error: 'No result returned from agent',
      rawCount: 0,
      malformedCount: 0,
    };
  }

  if (taskResult.status === 'TIMEOUT') {
    return {
      status: 'TIMEOUT',
      alerts: [],
      error: taskResult.error || 'Agent task timeout',
      rawCount: 0,
      malformedCount: 0,
    };
  }

  if (taskResult.exit_code !== undefined && taskResult.exit_code !== 0 && !taskResult.stdout) {
    return {
      status: 'EXEC_FAILED',
      alerts: [],
      error:
        taskResult.error ||
        taskResult.stderr ||
        `Command exited with code ${taskResult.exit_code}`,
      rawCount: 0,
      malformedCount: 0,
    };
  }

  const stdout = (taskResult.stdout || '').trim();
  if (!stdout) {
    return {
      status: 'PARSE_FAILED',
      alerts: [],
      error: 'Empty stdout without status header',
      rawCount: 0,
      malformedCount: 0,
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
    return {
      status,
      alerts: [],
      error: errorMsg,
      rawCount: 0,
      malformedCount: 0,
    };
  }

  const rawAlertLines = lines.slice(1);
  const alerts: IpqaAlert[] = [];
  const seenRaw = new Set<string>();
  let malformedCount = 0;

  for (const line of rawAlertLines) {
    if (!line.trim()) continue;

    const alert = parseAlertLine(line);
    if (!alert) {
      malformedCount++;
      continue;
    }

    if (seenRaw.has(alert.raw)) {
      continue;
    }
    seenRaw.add(alert.raw);
    alert.source = 'alerts_log';
    alerts.push(alert);
  }

  return {
    status: 'OK',
    alerts,
    rawCount: rawAlertLines.filter(l => l.trim().length > 0).length,
    malformedCount,
  };
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
  const legacy = parseLegacyTaskResult(taskResult);

  if (legacy.status !== 'OK') {
    console.log(`[IPQA] ${node.name}: ${legacy.status}`);
    return {
      uuid: node.uuid,
      name: node.name,
      weight: node.weight,
      status: legacy.status,
      alerts: [],
      error: legacy.error,
    };
  }

  if (legacy.malformedCount > 0) {
    console.warn(`[IPQA] ${node.name}: ${legacy.malformedCount} malformed alert line(s)`);
  }

  const filterRes = filterAlerts(legacy.alerts, config);

  console.log(
    `[IPQA] ${node.name}: OK, raw=${legacy.rawCount}, filtered=${filterRes.alerts.length}`
  );

  return {
    uuid: node.uuid,
    name: node.name,
    weight: node.weight,
    status: 'OK',
    alerts: filterRes.alerts,
  };
}
