import { registerScheduler, type ServerContext } from './scheduler.ts';
import { runTestReport } from './test.ts';
import { registerApiRoutes } from './api/routes.ts';
import { loadConfig } from './config.ts';

// Komari plugin runtime injects 'server' module or global definePlugin
let serverInstance: ServerContext;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  serverInstance = require('server');
} catch {
  // If running in an environment where server is injected globally
  // @ts-expect-error global server
  serverInstance = typeof server !== 'undefined' ? server : null;
}

export function isAdminPrincipal(principal: any): boolean {
  return Boolean(
    principal &&
      ((principal.type === 'user' && principal.roles?.includes('admin')) ||
        principal.type === 'api_key' ||
        principal.is_api_key === true)
  );
}

/**
 * Plugin lifecycle: load()
 */
export async function load(): Promise<void> {
  console.log('[IPQA] Loading IPQA Alert Report plugin v0.2.1...');

  if (!serverInstance) {
    try {
      serverInstance = require('server');
    } catch (e) {
      throw new Error(
        `Failed to acquire Komari server module: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // Register manual test endpoints
  // @ts-expect-error server.route
  if (typeof serverInstance.route === 'function') {
    const testRouteHandler = async (req: any, res: any) => {
      try {
        const p = req?.context?.principal;
        const isAdmin = isAdminPrincipal(p);
        if (!isAdmin) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ success: false, error: 'Forbidden: Admin access required' }));
          return;
        }

        let options = {};
        if (typeof req.body === 'string' && req.body.trim()) {
          try {
            options = JSON.parse(req.body);
          } catch {
            // ignore
          }
        } else if (req.body && typeof req.body === 'object') {
          options = req.body;
        }

        const result = await runTestReport(serverInstance, options);
        res.statusCode = result.success ? 200 : 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    };

    // @ts-expect-error server.route
    serverInstance.route('POST', '/api/plugin/ipqa-alert-report/test', testRouteHandler);
    // @ts-expect-error server.route
    serverInstance.route('POST', '/api/ipqa-alert-report/test', testRouteHandler);
    console.log('[IPQA] Test endpoints registered at /api/plugin/ipqa-alert-report/test');

    const syncRouteHandler = async (req: any, res: any) => {
      try {
        const p = req?.context?.principal;
        const isAdmin = isAdminPrincipal(p);
        if (!isAdmin) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ success: false, error: 'Forbidden: Admin access required' }));
          return;
        }

        const { syncIpqaArchives } = await import('./ipqa/archive-sync.ts');
        const result = await syncIpqaArchives(serverInstance, { reason: 'manual' });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ success: true, result }));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    };

    // @ts-expect-error server.route
    serverInstance.route('POST', '/api/plugin/ipqa-alert-report/sync', syncRouteHandler);
    // @ts-expect-error server.route
    serverInstance.route('POST', '/api/ipqa-alert-report/sync', syncRouteHandler);
    console.log('[IPQA] Admin sync endpoints registered at /api/plugin/ipqa-alert-report/sync');
  }

  // Register manual test RPC
  // @ts-expect-error server.registerRPC
  if (typeof serverInstance.registerRPC === 'function') {
    // @ts-expect-error server.registerRPC
    serverInstance.registerRPC('plugin:ipqaTestRun', async (params: any) => {
      return await runTestReport(serverInstance, params || {});
    });
    console.log('[IPQA] Test RPC registered: plugin:ipqaTestRun');

    // @ts-expect-error server.registerRPC
    serverInstance.registerRPC('plugin:ipqaSyncNow', async (params: any) => {
      const { syncIpqaArchives } = await import('./ipqa/archive-sync.ts');
      return await syncIpqaArchives(serverInstance, {
        reason: 'manual',
        selectedNodeUuids: params?.selectedNodeUuids,
      });
    });
    console.log('[IPQA] Sync RPC registered: plugin:ipqaSyncNow');
  }

  registerScheduler(serverInstance);

  const initialConfig = await loadConfig(serverInstance);
  console.log(
    `[IPQA] Archive sync ${initialConfig.sync_archives ? 'enabled: true' : 'disabled by configuration'}`
  );

  // Register IPQA Versioned Public Read API (Section 25)
  try {
    registerApiRoutes(serverInstance);
  } catch (apiErr) {
    console.warn('[IPQA] Failed to register API routes:', apiErr);
  }

  // Initial history backfill in background after 30s (Section 4 & 20)
  setTimeout(async () => {
    try {
      const config = await loadConfig(serverInstance);
      if (config.enabled && config.sync_archives) {
        console.log('[IPQA] Triggering initial background archive backfill...');
        const { syncIpqaArchives } = await import('./ipqa/archive-sync.ts');
        await syncIpqaArchives(serverInstance, { reason: 'startup' });
      }
    } catch (backfillErr) {
      console.warn('[IPQA] Initial background backfill encountered error:', backfillErr);
    }
  }, 30_000);

  console.log('[IPQA] IPQA Alert Report plugin loaded successfully.');
}

/**
 * Plugin lifecycle: unload()
 */
export async function unload(): Promise<void> {
  console.log('[IPQA] Unloading IPQA Alert Report plugin...');
}

// Ensure global functions for Goja runtime
if (typeof globalThis !== 'undefined') {
  // @ts-expect-error global scope
  globalThis.load = load;
  // @ts-expect-error global scope
  globalThis.unload = unload;
}

// In case Komari SDK's definePlugin is used
declare const definePlugin:
  | ((plugin: { load?: () => Promise<void> | void; unload?: () => Promise<void> | void }) => void)
  | undefined;

if (typeof definePlugin === 'function') {
  definePlugin({ load, unload });
}
