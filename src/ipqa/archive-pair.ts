import type {
  IpqaDailyPairedReport,
  IpqaDailySummary,
  IpqaNormalizedReport,
  RiskCategory,
} from './types.ts';
import { getReportRiskCategory } from './archive-normalize.ts';

const RISK_RANK: Record<RiskCategory, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
  Unknown: 0,
};

function extractMediaAndAiSummary(
  v4: IpqaNormalizedReport | null,
  v6: IpqaNormalizedReport | null
): {
  mediaSummary: Record<string, { unlocked: boolean; region?: string }>;
  aiSummary: Record<string, { unlocked: boolean; region?: string }>;
} {
  const mediaSummary: Record<string, { unlocked: boolean; region?: string }> = {};
  const aiSummary: Record<string, { unlocked: boolean; region?: string }> = {};

  const services = new Set<string>();
  if (v4?.media) Object.keys(v4.media).forEach(s => services.add(s));
  if (v6?.media) Object.keys(v6.media).forEach(s => services.add(s));

  for (const svc of services) {
    const s4 = v4?.media[svc];
    const s6 = v6?.media[svc];

    const isUnlocked = (st?: string) => {
      if (!st) return false;
      return st.includes('解锁') || st.includes('Yes') || st.includes('仅自制');
    };

    const unlocked = isUnlocked(s4?.status) || isUnlocked(s6?.status);
    const region = s4?.region || s6?.region;

    if (svc.toLowerCase().includes('chatgpt') || svc.toLowerCase().includes('claude') || svc.toLowerCase().includes('openai')) {
      aiSummary[svc] = { unlocked, region };
    } else {
      mediaSummary[svc] = { unlocked, region };
    }
  }

  return { mediaSummary, aiSummary };
}

/**
 * Pairs v4 and v6 normalized reports into canonical daily reports (one per day).
 * If multiple reports exist on the same date, selects the latest by timestamp.
 */
export function pairDailyReports(
  v4Reports: IpqaNormalizedReport[],
  v6Reports: IpqaNormalizedReport[],
  nodeUuid: string
): IpqaDailyPairedReport[] {
  // 1. Group v4 by date, picking latest
  const v4ByDate = new Map<string, IpqaNormalizedReport>();
  for (const rep of v4Reports) {
    const existing = v4ByDate.get(rep.date);
    if (!existing || rep.timestamp > existing.timestamp) {
      v4ByDate.set(rep.date, rep);
    }
  }

  // 2. Group v6 by date, picking latest
  const v6ByDate = new Map<string, IpqaNormalizedReport>();
  for (const rep of v6Reports) {
    const existing = v6ByDate.get(rep.date);
    if (!existing || rep.timestamp > existing.timestamp) {
      v6ByDate.set(rep.date, rep);
    }
  }

  // 3. Union of all dates
  const allDates = new Set<string>([...v4ByDate.keys(), ...v6ByDate.keys()]);
  const paired: IpqaDailyPairedReport[] = [];

  for (const date of allDates) {
    const v4 = v4ByDate.get(date) ?? null;
    const v6 = v6ByDate.get(date) ?? null;

    const riskV4 = getReportRiskCategory(v4);
    const riskV6 = getReportRiskCategory(v6);

    let highestRiskCategory: RiskCategory = 'Unknown';
    let highestRiskSource = 'None';

    const rank4 = RISK_RANK[riskV4.category] ?? 0;
    const rank6 = RISK_RANK[riskV6.category] ?? 0;

    if (rank4 === 0 && rank6 === 0) {
      highestRiskCategory = 'Unknown';
      highestRiskSource = 'None';
    } else if (rank4 >= rank6) {
      highestRiskCategory = riskV4.category;
      highestRiskSource = riskV4.source !== 'None' ? `${riskV4.source}` : riskV4.source;
    } else {
      highestRiskCategory = riskV6.category;
      highestRiskSource = riskV6.source !== 'None' ? `${riskV6.source}` : riskV6.source;
    }

    const { mediaSummary, aiSummary } = extractMediaAndAiSummary(v4, v6);

    const summary: IpqaDailySummary = {
      hasV4: v4 !== null,
      hasV6: v6 !== null,
      highestRiskCategory,
      highestRiskSource,
      mediaSummary,
      aiSummary,
    };

    paired.push({
      schemaVersion: 1,
      nodeUuid,
      date,
      updatedAt: new Date().toISOString(),
      v4,
      v6,
      summary,
    });
  }

  // Sort newest first
  paired.sort((a, b) => b.date.localeCompare(a.date));
  return paired;
}
