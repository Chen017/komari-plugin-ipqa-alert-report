import type { KomariNode, PluginConfig } from './types.ts';

/**
 * Fetches all nodes from Komari RPC `common:getNodes`.
 * Supports both map format (`{ [uuid]: node }`) and array format (`node[]`).
 */
export async function fetchAllNodes(server: {
  call: (method: string, params?: unknown) => Promise<unknown>;
}): Promise<KomariNode[]> {
  try {
    const res = await server.call('common:getNodes');
    if (!res) {
      return [];
    }

    let rawList: unknown[] = [];
    if (Array.isArray(res)) {
      rawList = res;
    } else if (typeof res === 'object') {
      rawList = Object.entries(res as Record<string, unknown>).map(
        ([key, val]) => {
          if (val && typeof val === 'object') {
            const obj = val as Record<string, unknown>;
            return {
              uuid: obj.uuid || obj.id || key,
              ...obj,
            };
          }
          return { uuid: key, name: key, weight: 0 };
        }
      );
    }

    return rawList.map((item, idx) => {
      const obj = (item || {}) as Record<string, unknown>;
      const uuid = String(obj.uuid || obj.id || obj.client_id || `node-${idx}`);
      const name = String(obj.name || obj.hostname || uuid);
      const weight = typeof obj.weight === 'number' ? obj.weight : 0;
      return {
        ...obj,
        uuid,
        name,
        weight,
      };
    });
  } catch (err) {
    console.error('[IPQA] Failed to call common:getNodes', err);
    return [];
  }
}

/**
 * Resolves target nodes based on configuration and sorts them by weight ascending.
 */
export function resolveTargetNodes(
  config: PluginConfig,
  allNodes: KomariNode[]
): KomariNode[] {
  let selected: KomariNode[] = [];

  if (config.all_nodes) {
    selected = [...allNodes];
  } else {
    const selectedUuids = new Set(config.nodes);
    selected = allNodes.filter(node => {
      if (selectedUuids.has(node.uuid)) return true;
      if (node.id !== undefined && selectedUuids.has(String(node.id))) return true;
      if (node.client_id !== undefined && selectedUuids.has(String(node.client_id))) return true;
      return false;
    });
  }

  // Sort by Komari weight ascending, tie-break by name
  selected.sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0) || a.name.localeCompare(b.name));

  return selected;
}
