import type { ServerContext } from '../scheduler.ts';
import {
  getDailyReport,
  getFleetOverview,
  getLatestDailyReport,
  listDailyDates,
} from '../storage/archive-store.ts';

const PLUGIN_VERSION = '0.2.0';
const API_PREFIX = '/api/plugin/ipqa-alert-report/v1';

function sendJson(res: any, status: number, data: any, maxAgeSeconds = 60): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}`);
  res.end(JSON.stringify(data));
}

function parseUrl(urlStr: string): { pathname: string; query: Record<string, string> } {
  const [pathname = '', search = ''] = urlStr.split('?');
  const query: Record<string, string> = {};
  if (search) {
    const params = new URLSearchParams(search);
    for (const [key, value] of params.entries()) {
      query[key] = value;
    }
  }
  return { pathname, query };
}

/**
 * Registers all versioned public read API endpoints (Section 25).
 * All endpoints are strictly read-only and read from local cache.
 */
export function registerApiRoutes(server: ServerContext): void {
  // @ts-expect-error server.route
  if (typeof server.route !== 'function') return;

  const handler = async (req: any, res: any) => {
    try {
      const { pathname, query } = parseUrl(req.url || '');

      // 1. /capabilities
      if (pathname === `${API_PREFIX}/capabilities`) {
        sendJson(res, 200, {
          schema_version: 1,
          plugin_version: PLUGIN_VERSION,
          archive_api: true,
          change_api: true,
          ipv4: true,
          ipv6: true,
        }, 300);
        return;
      }

      // 2. /overview
      if (pathname === `${API_PREFIX}/overview`) {
        const overview = getFleetOverview();
        if (!overview) {
          sendJson(res, 200, {
            schema_version: 1,
            updated_at: new Date().toISOString(),
            total_nodes: 0,
            ipqa_nodes: 0,
            nodes_with_risk: 0,
            nodes_with_changes_today: 0,
            latest_archive_date: null,
            nodes: [],
          });
          return;
        }
        sendJson(res, 200, overview, 60);
        return;
      }

      // 3. /nodes
      if (pathname === `${API_PREFIX}/nodes`) {
        const overview = getFleetOverview();
        sendJson(res, 200, overview?.nodes ?? [], 60);
        return;
      }

      // 4. /nodes/:uuid/...
      const nodePrefix = `${API_PREFIX}/nodes/`;
      if (pathname.startsWith(nodePrefix)) {
        const sub = pathname.slice(nodePrefix.length);
        const parts = sub.split('/');
        const uuid = parts[0];
        const action = parts[1];

        if (!uuid) {
          sendJson(res, 400, { error: 'Missing node uuid' });
          return;
        }

        // 4a. /nodes/:uuid/latest
        if (action === 'latest') {
          const latest = getLatestDailyReport(uuid);
          if (!latest) {
            sendJson(res, 404, { error: 'No archive found for node' });
            return;
          }
          sendJson(res, 200, latest, 60);
          return;
        }

        // 4b. /nodes/:uuid/archives
        if (action === 'archives') {
          const dateParam = parts[2];

          // Specific date: /nodes/:uuid/archives/:date
          if (dateParam) {
            const report = getDailyReport(uuid, dateParam);
            if (!report) {
              sendJson(res, 404, { error: `No archive found for date ${dateParam}` });
              return;
            }
            sendJson(res, 200, report, 3600);
            return;
          }

          // Date list: /nodes/:uuid/archives?limit=30&before=...
          let dates = listDailyDates(uuid);
          const before = query.before;
          if (before) {
            dates = dates.filter(d => d < before);
          }
          const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit || '30', 10)));
          dates = dates.slice(0, limit);

          sendJson(res, 200, { uuid, dates, total: dates.length }, 60);
          return;
        }

        // 4c. /nodes/:uuid/changes
        if (action === 'changes') {
          const dates = listDailyDates(uuid).slice(0, 30);
          const changes = [];
          for (const d of dates) {
            const rep = getDailyReport(uuid, d);
            if (rep?.changesFromPrevious?.length) {
              changes.push(...rep.changesFromPrevious);
            }
          }
          sendJson(res, 200, { uuid, changes }, 60);
          return;
        }

        // 4d. /nodes/:uuid/history/scores
        if (action === 'history' && parts[2] === 'scores') {
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
          sendJson(res, 200, { uuid, history }, 60);
          return;
        }

        // 4e. /nodes/:uuid/history/media
        if (action === 'history' && parts[2] === 'media') {
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
          sendJson(res, 200, { uuid, history }, 60);
          return;
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      console.error('[IPQA API] Error handling request:', err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Register wildcard / prefix routes
  // @ts-expect-error server.route
  server.route('GET', `${API_PREFIX}/capabilities`, handler);
  // @ts-expect-error server.route
  server.route('GET', `${API_PREFIX}/overview`, handler);
  // @ts-expect-error server.route
  server.route('GET', `${API_PREFIX}/nodes`, handler);
  // @ts-expect-error server.route
  server.route('GET', `${API_PREFIX}/nodes/*`, handler);

  console.log(`[IPQA] Versioned read API routes registered under ${API_PREFIX}`);
}
