export const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface BeijingParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Returns the date and time components in Asia/Shanghai (UTC+8).
 * Pure arithmetic calculation, independent of host machine timezone.
 */
export function getBeijingParts(now: Date = new Date()): BeijingParts {
  const bj = new Date(now.getTime() + BJT_OFFSET_MS);
  return {
    year: bj.getUTCFullYear(),
    month: bj.getUTCMonth() + 1,
    day: bj.getUTCDate(),
    hour: bj.getUTCHours(),
    minute: bj.getUTCMinutes(),
    second: bj.getUTCSeconds(),
  };
}

/**
 * Formats Beijing date parts into YYYY-MM-DD key.
 */
export function formatBeijingDateKey(bj: BeijingParts): string {
  const y = bj.year.toString();
  const m = bj.month.toString().padStart(2, '0');
  const d = bj.day.toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Converts Beijing date/time to UTC epoch seconds.
 */
export function beijingEpochSeconds(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  const utcMs =
    Date.UTC(year, month - 1, day, hour, minute, second) - BJT_OFFSET_MS;
  return Math.floor(utcMs / 1000);
}

/**
 * Calculates the daily report query window for a given Beijing date (YYYY-MM-DD).
 * Fixed to: [00:00:00, 07:00:59] Asia/Shanghai.
 */
export function getBeijingDailyWindow(dateKey: string): {
  startEpoch: number;
  endEpoch: number;
  windowStart: string;
  windowEnd: string;
} {
  const [yearStr, monthStr, dayStr] = dateKey.split('-');
  const y = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  const startEpoch = beijingEpochSeconds(y, m, d, 0, 0, 0);
  const endEpoch = beijingEpochSeconds(y, m, d, 7, 0, 59);

  return {
    startEpoch,
    endEpoch,
    windowStart: `${dateKey} 00:00:00`,
    windowEnd: `${dateKey} 07:00:59`,
  };
}

/**
 * Checks if the current time falls into the Beijing 07:00 trigger window.
 * Includes a 10-minute catch-up window: 07:00 <= Beijing Time < 07:10.
 */
export function isBeijingDue(now: Date = new Date()): boolean {
  const bj = getBeijingParts(now);
  return bj.hour === 7 && bj.minute >= 0 && bj.minute < 10;
}
