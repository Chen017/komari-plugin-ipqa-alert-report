import type { RiskCategory } from './types.ts';

export interface ClassifiedScore {
  provider: string;
  rawValue: string | number | boolean | null;
  numericValue: number | null;
  unit?: 'percent' | 'score' | 'other';
  category: RiskCategory;
  rank: number; // -1: Unknown, 0: Very Low, 1: Low, 2: Medium/Elevated, 3: High, 4: Critical
  badge: string; // e.g. "极低风险", "低风险", "中风险", "较高风险", "可疑IP", "高风险", "存在风险", "极高风险", "建议封禁"
}

export interface ScoreTransitionResult {
  provider: string;
  before: ClassifiedScore;
  after: ClassifiedScore;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  description: string;
  changed: boolean;
}

/**
 * Checks if a value is null-like.
 */
export function isNullLike(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === '' || s === 'null' || s === 'undefined' || s === 'n/a' || s === '--' || s === '-';
  }
  return false;
}

/**
 * Normalizes a raw score value into a clean numeric string or number.
 */
export function parseNumericScore(raw: unknown): number | null {
  if (isNullLike(raw)) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const str = raw.trim().replace(/%/g, '');
    const num = Number.parseFloat(str);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Classifies a single provider score based on IPQA (IP-Quality-Archive) rules.
 * Reference: Chen017/IP-Quality-Archive/ipqa.sh lines 1208-1300
 */
export function classifyScore(provider: string, rawVal: unknown): ClassifiedScore {
  if (isNullLike(rawVal)) {
    return {
      provider,
      rawValue: null,
      numericValue: null,
      category: 'Unknown',
      rank: -1,
      badge: '无数据',
    };
  }

  const prov = provider.trim();
  const provLower = prov.toLowerCase();

  // 1. ipapi: percentage format (e.g. "2.73%", "18.16%", "0.73%")
  // bp (basis points): 1% = 100 bp (e.g. 2.73% = 273 bp, 18.16% = 1816 bp)
  if (provLower === 'ipapi') {
    const rawStr = String(rawVal).trim();
    const num = parseNumericScore(rawStr);
    if (num === null) {
      return {
        provider: prov,
        rawValue: rawVal as any,
        numericValue: null,
        unit: 'percent',
        category: 'Unknown',
        rank: -1,
        badge: '无数据',
      };
    }

    const bp = Math.round(num * 100);
    let badge = '极低风险';
    let category: RiskCategory = 'Low';
    let rank = 0;

    if (bp < 15) {
      badge = '极低风险';
      category = 'Low';
      rank = 0;
    } else if (bp < 85) {
      badge = '低风险';
      category = 'Low';
      rank = 1;
    } else if (bp < 300) {
      badge = '较高风险';
      category = 'Medium';
      rank = 2;
    } else if (bp < 1000) {
      badge = '高风险';
      category = 'High';
      rank = 3;
    } else {
      badge = '极高风险';
      category = 'Critical';
      rank = 4;
    }

    return {
      provider: prov,
      rawValue: rawVal as any,
      numericValue: num,
      unit: 'percent',
      category,
      rank,
      badge,
    };
  }

  // 2. IP2LOCATION: 0-32 低 | 33-65 中 | 66+ 高, or textual "VERY HIGH", "HIGH", "MEDIUM", "LOW"
  if (provLower === 'ip2location') {
    const rawStr = String(rawVal).trim().toUpperCase();
    if (rawStr.includes('VERY HIGH')) {
      return { provider: prov, rawValue: rawVal as any, numericValue: 90, category: 'Critical', rank: 4, badge: '极高风险' };
    }
    if (rawStr.includes('HIGH')) {
      return { provider: prov, rawValue: rawVal as any, numericValue: 70, category: 'High', rank: 3, badge: '高风险' };
    }
    if (rawStr.includes('MEDIUM')) {
      return { provider: prov, rawValue: rawVal as any, numericValue: 50, category: 'Medium', rank: 2, badge: '中风险' };
    }
    if (rawStr.includes('LOW')) {
      return { provider: prov, rawValue: rawVal as any, numericValue: 10, category: 'Low', rank: 1, badge: '低风险' };
    }

    const num = parseNumericScore(rawVal);
    if (num !== null) {
      if (num < 33) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Low', rank: 1, badge: '低风险' };
      if (num < 66) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Medium', rank: 2, badge: '中风险' };
      return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'High', rank: 3, badge: '高风险' };
    }

    return { provider: prov, rawValue: rawVal as any, numericValue: null, category: 'Unknown', rank: -1, badge: '无数据' };
  }

  // 3. SCAMALYTICS: 0-19 低 | 20-59 中 | 60-89 高 | 90+ 极高
  if (provLower === 'scamalytics') {
    const num = parseNumericScore(rawVal);
    if (num !== null) {
      if (num < 20) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Low', rank: 1, badge: '低风险' };
      if (num < 60) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Medium', rank: 2, badge: '中风险' };
      if (num < 90) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'High', rank: 3, badge: '高风险' };
      return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Critical', rank: 4, badge: '极高风险' };
    }
    return { provider: prov, rawValue: rawVal as any, numericValue: null, category: 'Unknown', rank: -1, badge: '无数据' };
  }

  // 4. AbuseIPDB: 0-24 低 | 25-74 高 | 75+ 建议封禁
  if (provLower === 'abuseipdb') {
    const num = parseNumericScore(rawVal);
    if (num !== null) {
      if (num < 25) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Low', rank: 1, badge: '低风险' };
      if (num < 75) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'High', rank: 3, badge: '高风险' };
      return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Critical', rank: 4, badge: '建议封禁' };
    }
    return { provider: prov, rawValue: rawVal as any, numericValue: null, category: 'Unknown', rank: -1, badge: '无数据' };
  }

  // 5. IPQS: 0-74 低 | 75-84 可疑 | 85-89 存在风险 | 90+ 高风险
  if (provLower === 'ipqs' || provLower === 'ipqualityscore') {
    const num = parseNumericScore(rawVal);
    if (num !== null) {
      if (num < 75) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Low', rank: 1, badge: '低风险' };
      if (num < 85) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Medium', rank: 2, badge: '可疑IP' };
      if (num < 90) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'High', rank: 3, badge: '存在风险' };
      return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Critical', rank: 4, badge: '高风险' };
    }
    return { provider: prov, rawValue: rawVal as any, numericValue: null, category: 'Unknown', rank: -1, badge: '无数据' };
  }

  // 6. DBIP: 0 低 | 50 中 | 100 高
  if (provLower === 'dbip' || provLower === 'db-ip') {
    const num = parseNumericScore(rawVal);
    if (num !== null) {
      if (num === 0) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Low', rank: 1, badge: '低风险' };
      if (num <= 50) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Medium', rank: 2, badge: '中风险' };
      return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'High', rank: 3, badge: '高风险' };
    }
    return { provider: prov, rawValue: rawVal as any, numericValue: null, category: 'Unknown', rank: -1, badge: '无数据' };
  }

  // 7. Generic fallback
  const num = parseNumericScore(rawVal);
  if (num !== null) {
    if (num < 20) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Low', rank: 1, badge: '低风险' };
    if (num < 50) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Medium', rank: 2, badge: '中风险' };
    if (num < 75) return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'High', rank: 3, badge: '高风险' };
    return { provider: prov, rawValue: rawVal as any, numericValue: num, category: 'Critical', rank: 4, badge: '极高风险' };
  }

  return {
    provider: prov,
    rawValue: rawVal as any,
    numericValue: null,
    category: 'Unknown',
    rank: -1,
    badge: '无数据',
  };
}

/**
 * Classifies all scores in a scores map.
 */
export function classifyScores(scores: Record<string, unknown> = {}): ClassifiedScore[] {
  const result: ClassifiedScore[] = [];
  for (const [provider, rawVal] of Object.entries(scores)) {
    result.push(classifyScore(provider, rawVal));
  }
  return result;
}

/**
 * Determines the highest risk category, provider source, badge, and rank from a scores map.
 * Never defaults to Low if there are no valid scores.
 */
export function getHighestRisk(scores: Record<string, unknown> = {}): {
  category: RiskCategory;
  source: string;
  badge: string;
  rank: number;
} {
  const classified = classifyScores(scores).filter(s => s.rank >= 0);

  if (classified.length === 0) {
    return {
      category: 'Unknown',
      source: 'None',
      badge: '无数据',
      rank: -1,
    };
  }

  // Sort descending by rank
  classified.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    // Tie breaker: higher numericValue
    const bNum = b.numericValue ?? 0;
    const aNum = a.numericValue ?? 0;
    return bNum - aNum;
  });

  const top = classified[0]!;
  return {
    category: top.category,
    source: top.provider,
    badge: top.badge,
    rank: top.rank,
  };
}

/**
 * Compares two values for a score provider and produces a semantic transition and severity.
 */
export function compareScoreTransition(
  provider: string,
  beforeVal: unknown,
  afterVal: unknown
): ScoreTransitionResult {
  const before = classifyScore(provider, beforeVal);
  const after = classifyScore(provider, afterVal);

  const changed = beforeVal !== afterVal;

  let severity: 'CRITICAL' | 'WARNING' | 'INFO' = 'INFO';
  let description = `${provider} 风险评分变动: ${beforeVal ?? 'null'} -> ${afterVal ?? 'null'}`;

  if (before.rank >= 0 && after.rank >= 0) {
    // Both classified
    const rankDiff = after.rank - before.rank;
    if (after.rank >= 4 && rankDiff > 0) {
      // Reached Critical/建议封禁/极高风险
      severity = 'CRITICAL';
      description = `${provider} 风险等级跃升至严重: [${before.badge}] -> [${after.badge}] (${beforeVal} -> ${afterVal})`;
    } else if (rankDiff >= 2) {
      // Jumped 2+ levels (e.g. Low -> High)
      severity = 'CRITICAL';
      description = `${provider} 风险等级大幅恶化: [${before.badge}] -> [${after.badge}] (${beforeVal} -> ${afterVal})`;
    } else if (rankDiff > 0) {
      // Increased 1 level
      severity = 'WARNING';
      description = `${provider} 风险等级上升: [${before.badge}] -> [${after.badge}] (${beforeVal} -> ${afterVal})`;
    } else if (rankDiff < 0) {
      // Improved
      severity = 'INFO';
      description = `${provider} 风险等级下降: [${before.badge}] -> [${after.badge}] (${beforeVal} -> ${afterVal})`;
    } else {
      // Rank unchanged, check numeric delta
      const numB = before.numericValue ?? 0;
      const numA = after.numericValue ?? 0;
      if (numA > numB) {
        severity = 'WARNING';
      } else {
        severity = 'INFO';
      }
      description = `${provider} 风险评分变动: ${beforeVal} -> ${afterVal} (${after.badge})`;
    }
  } else if (after.rank >= 3) {
    // Newly appeared with High or Critical
    severity = after.rank >= 4 ? 'CRITICAL' : 'WARNING';
    description = `${provider} 新增高风险检出: [${after.badge}] (${afterVal})`;
  } else if (after.rank > before.rank) {
    severity = 'WARNING';
  }

  return {
    provider,
    before,
    after,
    severity,
    description,
    changed,
  };
}
