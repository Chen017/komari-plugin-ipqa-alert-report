import type { IpqaAlert, Severity } from '../types.ts';
import type { IpqaDailyPairedReport, IpqaSemanticChange } from './types.ts';

/**
 * Builds a deterministic, structured deduplication key for a semantic change.
 * Format: ${nodeUuid}|${ipVersion}|${category}|${field}|${before}|${after}
 */
export function buildSemanticDedupeKey(
  nodeUuid: string,
  change: IpqaSemanticChange
): string {
  const beforeStr = change.before === undefined ? '' : String(change.before);
  const afterStr = change.after === undefined ? '' : String(change.after);
  return `${nodeUuid}|${change.ipVersion}|${change.category}|${change.field}|${beforeStr}|${afterStr}`;
}

/**
 * Transforms semantic changes from an archive paired daily report into IpqaAlert objects.
 * Diff calculation is NOT performed here (always comes from dailyReport.changesFromPrevious).
 */
export function semanticChangesToAlerts(
  nodeUuid: string,
  dailyReport: IpqaDailyPairedReport
): IpqaAlert[] {
  const changes = dailyReport.changesFromPrevious ?? [];
  const alerts: IpqaAlert[] = [];

  for (const change of changes) {
    let timestamp = dailyReport.date;
    if (change.ipVersion === 'IPv6') {
      timestamp = dailyReport.v6?.timestamp || dailyReport.date;
    } else {
      timestamp = dailyReport.v4?.timestamp || dailyReport.date;
    }

    const dedupeKey = buildSemanticDedupeKey(nodeUuid, change);

    alerts.push({
      timestamp,
      level: change.severity as Severity,
      message: change.description,
      ipVersion: change.ipVersion,
      raw: `${timestamp}|${change.severity}|${change.description}|${change.ipVersion}`,
      source: 'archive_diff',
      dedupeKey,
    });
  }

  return alerts;
}
