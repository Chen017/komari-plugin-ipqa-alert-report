import type {
  ChangeCategory,
  ChangeSeverity,
  IpqaDailyPairedReport,
  IpqaNormalizedReport,
  IpqaSemanticChange,
  NormalizedIpVersion,
} from './types.ts';
import { compareScoreTransition } from './risk.ts';

function compareSingleVersion(
  prev: IpqaNormalizedReport | null,
  curr: IpqaNormalizedReport | null,
  nodeUuid: string,
  date: string,
  ipVer: NormalizedIpVersion
): IpqaSemanticChange[] {
  const changes: IpqaSemanticChange[] = [];
  if (!prev || !curr) return changes;

  // 1. Identity changes (IP, ASN, Country, Region, City, ISP)
  const identityFields: Array<keyof IpqaNormalizedReport['info']> = [
    'ip', 'country', 'region', 'city', 'asn', 'isp', 'organization',
  ];
  for (const f of identityFields) {
    const b = prev.info[f];
    const a = curr.info[f];
    if (b !== undefined && a !== undefined && String(b).trim() !== String(a).trim()) {
      changes.push({
        date,
        nodeUuid,
        ipVersion: ipVer,
        category: 'identity',
        severity: f === 'ip' ? 'CRITICAL' : 'WARNING',
        field: `info.${f}`,
        before: b,
        after: a,
        description: `${String(f).toUpperCase()} 发生变更: [${b}] -> [${a}]`,
      });
    }
  }

  // 2. IP Type changes
  if (prev.info.type && curr.info.type && prev.info.type !== curr.info.type) {
    changes.push({
      date,
      nodeUuid,
      ipVersion: ipVer,
      category: 'type',
      severity: 'CRITICAL',
      field: 'info.type',
      before: prev.info.type,
      after: curr.info.type,
      description: `IP 类型变更为: [${curr.info.type}] (原: [${prev.info.type}])`,
    });
  }

  // 3. Risk scores changes
  const scoreKeys = new Set([...Object.keys(prev.scores), ...Object.keys(curr.scores)]);
  for (const sk of scoreKeys) {
    const b = prev.scores[sk];
    const a = curr.scores[sk];
    if (b !== undefined && a !== undefined && b !== a) {
      const transition = compareScoreTransition(sk, b, a);
      if (transition.changed) {
        changes.push({
          date,
          nodeUuid,
          ipVersion: ipVer,
          category: 'score',
          severity: transition.severity,
          field: `scores.${sk}`,
          before: b,
          after: a,
          beforeCategory: transition.before.badge,
          afterCategory: transition.after.badge,
          beforeRank: transition.before.rank,
          afterRank: transition.after.rank,
          description: transition.description,
        });
      }
    }
  }

  // 4. Factor changes (added / cleared)
  const factorKeys = new Set([...Object.keys(prev.factors), ...Object.keys(curr.factors)]);
  for (const fk of factorKeys) {
    const bEngines = prev.factors[fk] || {};
    const aEngines = curr.factors[fk] || {};
    const allEngines = new Set([...Object.keys(bEngines), ...Object.keys(aEngines)]);

    for (const eng of allEngines) {
      const bVal = Boolean(bEngines[eng]);
      const aVal = Boolean(aEngines[eng]);
      if (!bVal && aVal) {
        changes.push({
          date,
          nodeUuid,
          ipVersion: ipVer,
          category: 'factor',
          severity: 'WARNING',
          field: `factors.${fk}.${eng}`,
          before: false,
          after: true,
          description: `新增风险标记: ${eng} 检出 ${fk} 因子`,
        });
      } else if (bVal && !aVal) {
        changes.push({
          date,
          nodeUuid,
          ipVersion: ipVer,
          category: 'factor',
          severity: 'INFO',
          field: `factors.${fk}.${eng}`,
          before: true,
          after: false,
          description: `风险标记解除: ${eng} 不再检出 ${fk} 因子`,
        });
      }
    }
  }

  // 5. Media & AI changes
  const mediaKeys = new Set([...Object.keys(prev.media), ...Object.keys(curr.media)]);
  for (const mk of mediaKeys) {
    const b = prev.media[mk];
    const a = curr.media[mk];

    // Status change
    if (b?.status && a?.status && b.status !== a.status) {
      const isDowngrade = a.status.includes('失败') || a.status.includes('屏蔽') || a.status.includes('仅自制');
      changes.push({
        date,
        nodeUuid,
        ipVersion: ipVer,
        category: 'media',
        severity: isDowngrade ? 'CRITICAL' : 'INFO',
        field: `media.${mk}.status`,
        before: b.status,
        after: a.status,
        description: `${mk} 解锁状态变动: [${b.status}] -> [${a.status}]`,
      });
    }

    // Region change
    if (b?.region && a?.region && b.region !== a.region) {
      changes.push({
        date,
        nodeUuid,
        ipVersion: ipVer,
        category: 'media',
        severity: 'WARNING',
        field: `media.${mk}.region`,
        before: b.region,
        after: a.region,
        description: `${mk} 解锁地区变动: [${b.region}] -> [${a.region}]`,
      });
    }
  }

  // 6. DNS blacklist count
  const prevBlacklist = Number((prev.mail as any)?.DNSBlacklist?.Blacklisted);
  const currBlacklist = Number((curr.mail as any)?.DNSBlacklist?.Blacklisted);
  if (
    Number.isFinite(prevBlacklist) &&
    Number.isFinite(currBlacklist) &&
    prevBlacklist !== currBlacklist
  ) {
    changes.push({
      date,
      nodeUuid,
      ipVersion: ipVer,
      category: 'dnsbl',
      severity: currBlacklist > prevBlacklist ? 'WARNING' : 'INFO',
      field: 'mail.DNSBlacklist.Blacklisted',
      before: prevBlacklist,
      after: currBlacklist,
      description:
        currBlacklist > prevBlacklist
          ? `DNS 黑名单拦截数增加 (从 ${prevBlacklist} 增至 ${currBlacklist})`
          : `DNS 黑名单拦截数下降 (从 ${prevBlacklist} 降至 ${currBlacklist})`,
    });
  }

  // 7. Generic leaf diff on extra fields (Section 24)
  diffLeafFields(prev.extra, curr.extra, 'extra', (path, before, after) => {
    changes.push({
      date,
      nodeUuid,
      ipVersion: ipVer,
      category: 'other',
      severity: 'INFO',
      field: path,
      before,
      after,
      description: `动态字段变动: ${path}: [${String(before)}] -> [${String(after)}]`,
    });
  });

  return changes;
}

const IGNORED_DIFF_PATH_REGEX = /(?:^|\.)(?:head|time|timestamp|date|archiveid|mtime|command|version|runtime|duration|uuid|client|created_at|finished_at)(?:$|\.)/i;

function diffLeafFields(
  a: any,
  b: any,
  prefix: string,
  onDiff: (path: string, before: unknown, after: unknown) => void
): void {
  if (IGNORED_DIFF_PATH_REGEX.test(prefix)) return;
  if (a === b) return;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    onDiff(prefix, a, b);
    return;
  }

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of allKeys) {
    diffLeafFields(a[k], b[k], `${prefix}.${k}`, onDiff);
  }
}

/**
 * Compares current daily paired report with the previous daily report.
 * Returns all semantic and generic leaf changes.
 */
export function compareDailyReports(
  prev: IpqaDailyPairedReport | null,
  curr: IpqaDailyPairedReport
): IpqaSemanticChange[] {
  if (!prev) {
    return [];
  }

  const v4Changes = compareSingleVersion(prev.v4, curr.v4, curr.nodeUuid, curr.date, 'IPv4');
  const v6Changes = compareSingleVersion(prev.v6, curr.v6, curr.nodeUuid, curr.date, 'IPv6');

  const allChanges = [...v4Changes, ...v6Changes];

  // Sort CRITICAL -> WARNING -> INFO
  const severityRank: Record<ChangeSeverity, number> = {
    CRITICAL: 3,
    WARNING: 2,
    INFO: 1,
  };

  allChanges.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
  return allChanges;
}
