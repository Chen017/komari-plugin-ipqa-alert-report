import type { PluginConfig, Severity } from './types.ts';

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  all_nodes: false,
  nodes: [],
  min_severity: 'INFO',
  ignore_initial_archive: true,
  notify_collection_failures: true,
  template: '',
  sync_archives: false,
};

/**
 * Normalizes severity string to valid Severity enum.
 */
export function normalizeSeverity(val: unknown): Severity {
  if (typeof val === 'string') {
    const upper = val.trim().toUpperCase();
    if (upper === 'CRITICAL') return 'CRITICAL';
    if (upper === 'WARNING') return 'WARNING';
    if (upper === 'INFO') return 'INFO';
  }
  return 'INFO';
}

/**
 * Normalizes nodes configuration field into a string array of UUIDs.
 */
export function normalizeNodes(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map(item => String(item).trim()).filter(Boolean);
        }
      } catch {
        // fall back to comma split
      }
    }
    return trimmed
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Loads and validates plugin configuration from Komari server.
 */
export async function loadConfig(server: {
  getConfig: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}): Promise<PluginConfig> {
  let raw: Record<string, unknown> = {};
  try {
    const res = await server.getConfig();
    if (res && typeof res === 'object') {
      raw = res;
    }
  } catch (err) {
    console.error('[IPQA] Failed to read plugin config, using defaults', err);
  }

  return {
    enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : DEFAULT_CONFIG.enabled,
    all_nodes: raw.all_nodes !== undefined ? Boolean(raw.all_nodes) : DEFAULT_CONFIG.all_nodes,
    nodes: normalizeNodes(raw.nodes),
    min_severity: normalizeSeverity(raw.min_severity),
    ignore_initial_archive:
      raw.ignore_initial_archive !== undefined
        ? Boolean(raw.ignore_initial_archive)
        : DEFAULT_CONFIG.ignore_initial_archive,
    notify_collection_failures:
      raw.notify_collection_failures !== undefined
        ? Boolean(raw.notify_collection_failures)
        : DEFAULT_CONFIG.notify_collection_failures,
    template: typeof raw.template === 'string' ? raw.template : DEFAULT_CONFIG.template,
    sync_archives:
      raw.sync_archives !== undefined
        ? Boolean(raw.sync_archives)
        : DEFAULT_CONFIG.sync_archives,
  };
}
