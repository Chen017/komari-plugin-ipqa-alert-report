import { formatBeijingDateKey, getBeijingParts } from '../time.ts';
import type { NodeFreshness } from './types.ts';

export interface FreshnessInput {
  now?: Date;
  latestDate: string | null;
  hasArchives?: boolean;
  lastSyncError?: string | null;
  lastSyncAttemptAt?: string | null;
  lastSyncSuccessAt?: string | null;
  isInstalled?: boolean;
}

/**
 * Calculates schedule-aware freshness based on Beijing time 04:00 daily IPQA schedule + 60m grace.
 * Independent of host machine or VPS timezone.
 */
export function calculateFreshness(input: FreshnessInput): NodeFreshness {
  const now = input.now ?? new Date();
  const bj = getBeijingParts(now);
  const todayDate = formatBeijingDateKey(bj);
  const yesterdayDate = formatBeijingDateKey(
    getBeijingParts(new Date(now.getTime() - 24 * 3600 * 1000))
  );

  const lastSyncAttemptAt = input.lastSyncAttemptAt ?? null;
  const lastSyncSuccessAt = input.lastSyncSuccessAt ?? null;
  const reason = input.lastSyncError ?? null;

  if (input.isInstalled === false) {
    return {
      status: 'not_installed',
      latestDate: null,
      expectedDate: todayDate,
      lastSyncAttemptAt,
      lastSyncSuccessAt,
      reason,
    };
  }

  const hasArchives = input.hasArchives ?? Boolean(input.latestDate);
  if (!hasArchives || !input.latestDate) {
    return {
      status: 'no_archive',
      latestDate: null,
      expectedDate: todayDate,
      lastSyncAttemptAt,
      lastSyncSuccessAt,
      reason,
    };
  }

  const latest = input.latestDate;

  // 1. Future date anomaly
  if (latest > todayDate) {
    return {
      status: 'future_date',
      latestDate: latest,
      expectedDate: todayDate,
      lastSyncAttemptAt,
      lastSyncSuccessAt,
      reason,
    };
  }

  // 2. Before 04:00 Beijing Time (today's 04:00 scheduled scan has not arrived yet, yesterday is fresh)
  if (bj.hour < 4) {
    if (latest === todayDate || latest === yesterdayDate) {
      return {
        status: 'fresh',
        latestDate: latest,
        expectedDate: todayDate,
        lastSyncAttemptAt,
        lastSyncSuccessAt,
        reason: null,
      };
    }
    // Older than yesterday is stale
    return {
      status: 'stale',
      latestDate: latest,
      expectedDate: todayDate,
      lastSyncAttemptAt,
      lastSyncSuccessAt,
      reason,
    };
  }

  // 3. Between 04:00 and 05:00 Beijing Time (today's scan underway / in grace window)
  if (bj.hour === 4) {
    if (latest === todayDate) {
      return {
        status: 'fresh',
        latestDate: latest,
        expectedDate: todayDate,
        lastSyncAttemptAt,
        lastSyncSuccessAt,
        reason: null,
      };
    }
    if (latest === yesterdayDate) {
      return {
        status: 'pending_today',
        latestDate: latest,
        expectedDate: todayDate,
        lastSyncAttemptAt,
        lastSyncSuccessAt,
        reason: null,
      };
    }
    // Older than yesterday is stale
    return {
      status: 'stale',
      latestDate: latest,
      expectedDate: todayDate,
      lastSyncAttemptAt,
      lastSyncSuccessAt,
      reason,
    };
  }

  // 3. At or after 05:00 Beijing Time (today's report should be present)
  if (latest === todayDate) {
    return {
      status: 'fresh',
      latestDate: latest,
      expectedDate: todayDate,
      lastSyncAttemptAt,
      lastSyncSuccessAt,
      reason: null,
    };
  }

  // latest < todayDate
  if (input.lastSyncError) {
    return {
      status: 'sync_error',
      latestDate: latest,
      expectedDate: todayDate,
      lastSyncAttemptAt,
      lastSyncSuccessAt,
      reason: input.lastSyncError,
    };
  }

  return {
    status: 'stale',
    latestDate: latest,
    expectedDate: todayDate,
    lastSyncAttemptAt,
    lastSyncSuccessAt,
    reason,
  };
}
