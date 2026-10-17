import type { ServerContext } from '../scheduler.ts';
import {
  getDailyReport,
  getFleetOverview,
  getLatestDailyReport,
  listDailyDates,
  isValidNodeId,
  isValidArchiveDate,
  saveFleetOverview,
} from '../storage/archive-store.ts';
import { fetchAllNodes } from '../nodes.ts';

const PLUGIN_VERSION = '0.2.2';
const API_PREFIX = '/api/plugin/ipqa-alert-report/v1';

function parseUrl(urlStr: string): { pathname: string; query: Record<string, string> } {
  const [pathname = '', search = ''] = urlStr.split('?');
  const query: Record<string, string> = {};
  if (search) {
    const pairs = search.split('&');
    for (const pair of pairs) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      if (idx !== -1) {
        try {
          const k = decodeURIComponent(pair.slice(0, idx));
          const v = decodeURIComponent(pair.slice(idx + 1));
          query[k] = v;
        } catch {
          query[pair.slice(0, idx)] = pair.slice(idx + 1);
        }
      } else {
        try {
          query[decodeURIComponent(pair)] = '';
        } catch {
          query[pair] = '';
        }
      }
    }
  }
  return { pathname, query };
}

function getRequestAndResponse(req: any, res: any): {
  pathname: string;
  query: Record<string, string>;
  sendJson: (status: number, data: any, maxAgeSeconds?: number) => void;
} {
  const { pathname, query } = parseUrl(
    typeof req?.url === 'string' ? req.url : ''
  );

  const sendJson = (status: number, data: any, maxAgeSeconds = 60) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
    res.end(JSON.stringify(data));
  };

  return { pathname, query, sendJson };
}

// Data query handlers
export function handleGetCapabilities() {
  return {
    schema_version: 1,
    plugin_version: PLUGIN_VERSION,
    archive_api: true,
    change_api: true,
    ipv4: true,
    ipv6: true,
  };
}

export function filterFleetOverview(overview: any, filterUuids?: string[]): any {
  if (!overview || !Array.isArray(overview.nodes)) {
    return overview;
  }
  if (!Array.isArray(filterUuids) || filterUuids.length === 0) {
    return overview;
  }
  const set = new Set(filterUuids);
  const filteredNodes = overview.nodes.filter((n: any) => set.has(n.uuid));
  return {
    ...overview,
    total_nodes: filteredNodes.length,
    ipqa_nodes: filteredNodes.filter((n: any) => n.status !== 'no_archive').length,
    nodes_with_risk: filteredNodes.filter((n: any) => n.highest_risk && n.highest_risk.category !== 'Unknown' && n.highest_risk.category !== 'None').length,
    nodes_with_changes_today: filteredNodes.filter((n: any) => (n.changes_today ?? 0) > 0).length,
    nodes: filteredNodes,
  };
}

export function handleGetOverview(filterUuids?: string[]) {
  const overview = getFleetOverview();
  if (!overview) {
    return {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      total_nodes: 0,
      ipqa_nodes: 0,
      nodes_with_risk: 0,
      nodes_with_changes_today: 0,
      latest_archive_date: null,
      nodes: [],
    };
  }
  return filterFleetOverview(overview, filterUuids);
}

export async function handleGetOverviewAsync(server?: ServerContext, filterUuids?: string[]) {
  let overview = getFleetOverview();
  if (!overview) {
    return {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      total_nodes: 0,
      ipqa_nodes: 0,
      nodes_with_risk: 0,
      nodes_with_changes_today: 0,
      latest_archive_date: null,
      nodes: [],
    };
  }

  // Prune any deleted nodes from the persisted fleet overview if Komari server context is provided
  if (server && typeof server.call === 'function') {
    try {
      const liveNodes = await fetchAllNodes(server);
      if (Array.isArray(liveNodes)) {
        const liveSet = new Set(liveNodes.map(n => n.uuid));
        const initialCount = overview.nodes.length;
        const prunedNodes = overview.nodes.filter((n: any) => liveSet.has(n.uuid));
        if (prunedNodes.length !== initialCount) {
          overview = {
            ...overview,
            updated_at: new Date().toISOString(),
            total_nodes: prunedNodes.length,
            ipqa_nodes: prunedNodes.filter((n: any) => n.status !== 'no_archive').length,
            nodes_with_risk: prunedNodes.filter((n: any) => n.highest_risk && n.highest_risk.category !== 'Unknown' && n.highest_risk.category !== 'None').length,
            nodes_with_changes_today: prunedNodes.filter((n: any) => (n.changes_today ?? 0) > 0).length,
            nodes: prunedNodes,
          };
          saveFleetOverview(overview);
        }
      }
    } catch {
      // Graceful fallback to cached overview if RPC fails
    }
  }

  return filterFleetOverview(overview, filterUuids);
}

export function handleGetNodes(filterUuids?: string[]) {
  const overview = handleGetOverview(filterUuids);
  return overview.nodes ?? [];
}

export async function handleGetNodesAsync(server?: ServerContext, filterUuids?: string[]) {
  const overview = await handleGetOverviewAsync(server, filterUuids);
  return overview.nodes ?? [];
}

export function handleGetNodeLatest(uuid: string) {
  if (!isValidNodeId(uuid)) return null;
  return getLatestDailyReport(uuid);
}

export function handleGetNodeArchives(uuid: string, limit = 30, before?: string) {
  if (!isValidNodeId(uuid) || (before !== undefined && !isValidArchiveDate(before)))
    return { uuid, dates: [], total: 0, hasMore: false };
  let dates = listDailyDates(uuid);
  if (before) {
    dates = dates.filter(d => d < before);
  }
  const total = dates.length;
  const lim = Number.isFinite(Number(limit)) ? Math.min(100, Math.max(1, Math.floor(Number(limit) || 30))) : 30;
  dates = dates.slice(0, lim);
  return { uuid, dates, total, hasMore: total > dates.length };
}

export function handleGetNodeArchive(uuid: string, date: string) {
  if (!isValidNodeId(uuid) || !isValidArchiveDate(date)) return null;
  return getDailyReport(uuid, date);
}

export function handleGetNodeChanges(uuid: string) {
  if (!uuid) return { uuid, changes: [] };
  const dates = listDailyDates(uuid).slice(0, 30);
  const changes = [];
  for (const d of dates) {
    const rep = getDailyReport(uuid, d);
    if (rep?.changesFromPrevious?.length) {
      changes.push(...rep.changesFromPrevious);
    }
  }
  return { uuid, changes };
}

export function handleGetNodeScoreHistory(uuid: string) {
  if (!uuid) return { uuid, history: [] };
  const dates = listDailyDates(uuid).slice(0, 30);
  const history = [];
  for (const d of dates) {
    const rep = getDailyReport(uuid, d);
    if (rep) {
      history.push({
        date: rep.date,
        v4: rep.v4?.scores ?? null,
        v6: rep.v6?.scores ?? null,
        highestRisk: rep.summary.highestRiskCategory,
      });
    }
  }
  return { uuid, history };
}

export function handleGetNodeMediaHistory(uuid: string) {
  if (!uuid) return { uuid, history: [] };
  const dates = listDailyDates(uuid).slice(0, 30);
  const history = [];
  for (const d of dates) {
    const rep = getDailyReport(uuid, d);
    if (rep) {
      history.push({
        date: rep.date,
        mediaSummary: rep.summary.mediaSummary,
        aiSummary: rep.summary.aiSummary,
      });
    }
  }
  return { uuid, history };
}

/**
 * Registers all versioned public read API endpoints (Section 25).
 * Registers both HTTP endpoints and RPC methods for maximum compatibility with all Komari environments.
 */
export function registerApiRoutes(server: ServerContext): void {
  // 1. Register RPC methods (Komari native RPC)
  // @ts-expect-error server.registerRPC
  if (typeof server.registerRPC === 'function') {
    try {
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetCapabilities', async () => handleGetCapabilities());
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetOverview', async (p: any) => handleGetOverviewAsync(server, p?.uuids));
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetNodes', async (p: any) => handleGetNodesAsync(server, p?.uuids));
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetNodeLatest', async (p: any) => handleGetNodeLatest(p?.uuid));
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetNodeArchives', async (p: any) => handleGetNodeArchives(p?.uuid, p?.limit, p?.before));
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetNodeArchive', async (p: any) => handleGetNodeArchive(p?.uuid, p?.date));
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetNodeChanges', async (p: any) => handleGetNodeChanges(p?.uuid));
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetNodeScoreHistory', async (p: any) => handleGetNodeScoreHistory(p?.uuid));
      // @ts-expect-error server.registerRPC
      server.registerRPC('plugin:ipqaGetNodeMediaHistory', async (p: any) => handleGetNodeMediaHistory(p?.uuid));
      console.log('[IPQA] Read-only RPC methods registered under plugin:ipqa*');
    } catch (rpcErr) {
      console.warn('[IPQA] Failed to register RPC methods:', rpcErr);
    }
  }

  // 2. Register HTTP route handler
  // @ts-expect-error server.route
  if (typeof server.route !== 'function') return;

  const handler = async (arg1: any, arg2: any) => {
    let sendJsonFn: (status: number, data: any, maxAgeSeconds?: number) => void = () => {};
    try {
      const { pathname, query, sendJson } = getRequestAndResponse(arg1, arg2);
      sendJsonFn = sendJson;

      const uuidsParam = query.uuids
        ? query.uuids.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;

      // 1. /capabilities
      if (pathname.endsWith('/capabilities')) {
        sendJson(200, handleGetCapabilities(), 300);
        return;
      }

      // 2. /overview
      if (pathname.endsWith('/overview')) {
        const overview = await handleGetOverviewAsync(server, uuidsParam);
        sendJson(200, overview, 10);
        return;
      }

      // 3. /nodes
      if (pathname.endsWith('/nodes')) {
        const nodes = await handleGetNodesAsync(server, uuidsParam);
        sendJson(200, nodes, 10);
        return;
      }

      // 4. /nodes/:uuid/...
      const nodeMarker = '/nodes/';
      const idx = pathname.indexOf(nodeMarker);
      if (idx !== -1) {
        const sub = pathname.slice(idx + nodeMarker.length);
        const parts = sub.split('/');
        const uuid = parts[0];
        const action = parts[1];

        if (!uuid) {
          sendJson(400, { error: 'Missing node uuid' });
          return;
        }

        // 4a. /nodes/:uuid/latest
        if (action === 'latest') {
          const latest = handleGetNodeLatest(uuid);
          if (!latest) {
            sendJson(404, { error: 'No archive found for node' });
            return;
          }
          sendJson(200, latest, 60);
          return;
        }

        // 4b. /nodes/:uuid/archives
        if (action === 'archives') {
          const dateParam = parts[2];
          if (dateParam) {
            const report = handleGetNodeArchive(uuid, dateParam);
            if (!report) {
              sendJson(404, { error: `No archive found for date ${dateParam}` });
              return;
            }
            sendJson(200, report, 3600);
            return;
          }

          const result = handleGetNodeArchives(uuid, Number(query.limit || 30), query.before);
          sendJson(200, result, 60);
          return;
        }

        // 4c. /nodes/:uuid/changes
        if (action === 'changes') {
          const result = handleGetNodeChanges(uuid);
          sendJson(200, result, 60);
          return;
        }

        // 4d. /nodes/:uuid/history/scores
        if (action === 'history' && parts[2] === 'scores') {
          const result = handleGetNodeScoreHistory(uuid);
          sendJson(200, result, 60);
          return;
        }

        // 4e. /nodes/:uuid/history/media
        if (action === 'history' && parts[2] === 'media') {
          const result = handleGetNodeMediaHistory(uuid);
          sendJson(200, result, 60);
          return;
        }
      }

      sendJson(404, { error: 'Not found' });
    } catch (err: any) {
      console.error('[IPQA API] Error handling request:', err?.message || String(err), err?.stack);
      sendJsonFn(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const safeRoute = (method: string, path: string) => {
    try {
      // @ts-expect-error server.route
      server.route(method, path, handler);
    } catch (err) {
      console.warn(`[IPQA] Notice: route ${method} ${path} not accepted by server router:`, err);
    }
  };

  safeRoute('GET', `${API_PREFIX}/capabilities`);
  safeRoute('GET', `${API_PREFIX}/overview`);
  safeRoute('GET', `${API_PREFIX}/nodes`);
  safeRoute('GET', `${API_PREFIX}/nodes/*action`);

  console.log(`[IPQA] Versioned read API routes registered under ${API_PREFIX}`);
}
