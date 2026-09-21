import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  IpqaDailyPairedReport,
  IpqaFleetOverview,
  IpVersion,
} from '../ipqa/types.ts';
import { getStorageDir } from '../state.ts';

export function getIpqaDir(): string {
  return path.join(getStorageDir(), 'ipqa');
}

export function getNodeDir(uuid: string): string {
  return path.join(getIpqaDir(), 'nodes', uuid);
}

/**
 * Windows-safe JSON write with directory creation and fallback.
 */
export function safeWriteJson(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(data, null, 2);
  const tempPath = `${filePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    try {
      fs.renameSync(tempPath, filePath);
    } catch {
      // Fallback on Windows if rename fails due to file lock
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
  } catch (err) {
    console.error(`[IPQA] Failed to write JSON to ${filePath}:`, err);
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore
    }
  }
}

export function safeReadJson<T>(filePath: string): T | null {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    }
  } catch (err) {
    console.warn(`[IPQA] Failed to read JSON from ${filePath}:`, err);
  }
  return null;
}

/**
 * Checks if a raw archive JSON file is already cached locally.
 */
export function hasRawArchive(uuid: string, ipVer: IpVersion, filename: string): boolean {
  const filePath = path.join(getNodeDir(uuid), 'raw', ipVer, filename);
  return fs.existsSync(filePath);
}

/**
 * Lists all cached raw filenames for a node and IP version.
 */
export function listCachedRawFilenames(uuid: string, ipVer: IpVersion): string[] {
  const dir = path.join(getNodeDir(uuid), 'raw', ipVer);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Saves a raw JSON archive into <storage>/ipqa/nodes/<uuid>/raw/<v4|v6>/<filename>.
 */
export function saveRawArchive(
  uuid: string,
  ipVer: IpVersion,
  filename: string,
  rawJson: any
): void {
  const filePath = path.join(getNodeDir(uuid), 'raw', ipVer, filename);
  safeWriteJson(filePath, rawJson);
}

/**
 * Reads a raw JSON archive from cache.
 */
export function readRawArchive(
  uuid: string,
  ipVer: IpVersion,
  filename: string
): any | null {
  const filePath = path.join(getNodeDir(uuid), 'raw', ipVer, filename);
  return safeReadJson(filePath);
}

/**
 * Saves a paired daily report into <storage>/ipqa/nodes/<uuid>/daily/<date>.json
 * and updates latest.json if this is the newest date.
 */
export function saveDailyReport(uuid: string, report: IpqaDailyPairedReport): void {
  const dailyPath = path.join(getNodeDir(uuid), 'daily', `${report.date}.json`);
  safeWriteJson(dailyPath, report);

  const latestPath = path.join(getNodeDir(uuid), 'latest.json');
  const currentLatest = safeReadJson<IpqaDailyPairedReport>(latestPath);

  if (!currentLatest || report.date >= currentLatest.date) {
    safeWriteJson(latestPath, report);
  }
}

/**
 * Gets a paired daily report for a node on a given date.
 */
export function getDailyReport(uuid: string, date: string): IpqaDailyPairedReport | null {
  const dailyPath = path.join(getNodeDir(uuid), 'daily', `${date}.json`);
  return safeReadJson<IpqaDailyPairedReport>(dailyPath);
}

/**
 * Gets the latest paired daily report for a node.
 */
export function getLatestDailyReport(uuid: string): IpqaDailyPairedReport | null {
  const latestPath = path.join(getNodeDir(uuid), 'latest.json');
  return safeReadJson<IpqaDailyPairedReport>(latestPath);
}

/**
 * Lists all available daily archive dates for a node, newest first.
 */
export function listDailyDates(uuid: string): string[] {
  const dailyDir = path.join(getNodeDir(uuid), 'daily');
  if (!fs.existsSync(dailyDir)) return [];
  try {
    return fs
      .readdirSync(dailyDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Saves the fleet-wide overview into <storage>/ipqa/node-index.json.
 */
export function saveFleetOverview(overview: IpqaFleetOverview): void {
  const filePath = path.join(getIpqaDir(), 'node-index.json');
  safeWriteJson(filePath, overview);
}

/**
 * Reads the fleet-wide overview from <storage>/ipqa/node-index.json.
 */
export function getFleetOverview(): IpqaFleetOverview | null {
  const filePath = path.join(getIpqaDir(), 'node-index.json');
  return safeReadJson<IpqaFleetOverview>(filePath);
}
