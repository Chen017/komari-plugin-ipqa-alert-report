import { fetchAllNodes } from './nodes.ts';
import { runRemoteTask } from './remote.ts';
import { registerScheduler, type ServerContext } from './scheduler.ts';
import { runTestReport } from './test.ts';

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

const REQUIRED_RPCS = [
  'common:getNodes',
  'admin:exec',
  'admin:getTaskResultsByTaskId',
  'admin:sendNotification',
];

let isCompatible = true;

/**
 * Validates RPC runtime compatibility on plugin load (Section 33).
 * If a required RPC is missing, sets isCompatible = false and logs clearly.
 */
export async function checkCompatibility(server: ServerContext): Promise<boolean> {
  let allPresent = true;

  // @ts-expect-error optional rpc check
  if (server.rpc && typeof server.rpc.has === 'function') {
    for (const rpc of REQUIRED_RPCS) {
      // @ts-expect-error optional rpc check
      const hasRpc = await server.rpc.has(rpc);
      if (!hasRpc) {
        allPresent = false;
        console.warn(
          `[IPQA] CRITICAL WARNING: Required RPC method "${rpc}" is not available in this Komari runtime!`
        );
      }
    }
  } else {
    if (typeof server.call !== 'function') {
      allPresent = false;
      console.error(
        '[IPQA] CRITICAL: server.call is not available! allowSystemRPC permission might be missing.'
      );
    }
  }

  isCompatible = allPresent;
  return allPresent;
}

/**
 * Phase 0 Compatibility PoC (Section 11 & Section 39).
 * Verifies that server.call("admin:exec") executes without 2FA interception.
 * Logs desensitized TaskResult structure (Section 10.3).
 */
export async function runPhase0PoC(server: ServerContext): Promise<boolean> {
  console.log('[IPQA] Running Phase 0 compatibility PoC...');
  try {
    const allNodes = await fetchAllNodes(server);
    if (allNodes.length === 0) {
      console.log('[IPQA] Phase 0 PoC: No nodes currently available in Komari, deferring check.');
      return true;
    }

    const testNode = allNodes[0];
    console.log(
      `[IPQA] Phase 0 PoC: testing admin:exec on node "${testNode.name}" (${testNode.uuid})...`
    );

    const { results } = await runRemoteTask(
      server,
      "printf 'IPQA_PLUGIN_POC\\n'",
      [testNode.uuid],
      15_000,
      1_000
    );

    const res = results.get(testNode.uuid);
    // Section 10.3: 输出一次脱敏后的 TaskResult 结构到插件日志
    if (res) {
      console.log(
        `[IPQA] Phase 0 TaskResult structure: status=${res.status}, exit_code=${res.exit_code}, has_stdout=${Boolean(
          res.stdout
        )}, has_stderr=${Boolean(res.stderr)}`
      );
    }

    if (!res) {
      console.warn('[IPQA] Phase 0 PoC: no TaskResult returned.');
      return false;
    }

    if (res.status === 'TIMEOUT') {
      console.warn(`[IPQA] Phase 0 PoC: task timed out: ${res.error || ''}`);
      return false;
    }

    if (typeof res.exit_code === 'number' && res.exit_code !== 0) {
      console.warn(
        `[IPQA] Phase 0 PoC: remote command failed with exit_code=${res.exit_code}, output="${(res.stdout || '').slice(0, 200)}"`
      );
      return false;
    }

    const stdout = (res.stdout || '').trim();

    if (!stdout.includes('IPQA_PLUGIN_POC')) {
      console.warn(
        `[IPQA] Phase 0 PoC: command completed but marker was missing. output="${stdout.slice(0, 200)}"`
      );
      return false;
    }

    console.log(
      '[IPQA] Phase 0 PoC PASSED: admin:exec and TaskResult polling are working.'
    );

    return true;
  } catch (err) {
    console.error('[IPQA] Phase 0 PoC FAILED during remote execution:', err);
    return false;
  }
}

/**
 * Plugin lifecycle: load()
 */
export async function load(): Promise<void> {
  console.log('[IPQA] Loading IPQA Alert Report plugin v0.1.0...');

  if (!serverInstance) {
    try {
      // @ts-expect-error runtime require
      serverInstance = require('server');
    } catch (e) {
      console.error('[IPQA] Failed to acquire Komari server module:', e);
      return;
    }
  }

  const rpcOk = await checkCompatibility(serverInstance);
  if (!rpcOk) {
    console.error(
      '[IPQA] Missing critical RPC methods. Daily report will not be scheduled for today.'
    );
    return;
  }

  const pocOk = await runPhase0PoC(serverInstance);
  if (!pocOk) {
    console.error(
      '[IPQA] Phase 0 PoC failed. Remote task submission or result polling is not working correctly. Stopping plugin scheduling.'
    );
    return;
  }

  // Register manual test endpoints
  // @ts-expect-error server.route
  if (typeof serverInstance.route === 'function') {
    const testRouteHandler = async (req: any, res: any) => {
      try {
        if (req && req.context && req.context.principal) {
          const p = req.context.principal;
          const isAdmin =
            (p.type === 'user' && (p.roles?.includes('admin') || p.role === 'admin')) ||
            p.is_api_key;
          if (!isAdmin && p.type !== 'anonymous') {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ success: false, error: 'Forbidden: Admin access required' }));
            return;
          }
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
  }

  // Register manual test RPC
  // @ts-expect-error server.registerRPC
  if (typeof serverInstance.registerRPC === 'function') {
    // @ts-expect-error server.registerRPC
    serverInstance.registerRPC('plugin:ipqaTestRun', async (params: any) => {
      return await runTestReport(serverInstance, params || {});
    });
    console.log('[IPQA] Test RPC registered: plugin:ipqaTestRun');
  }

  registerScheduler(serverInstance);

  console.log('[IPQA] IPQA Alert Report plugin loaded successfully.');
}

/**
 * Plugin lifecycle: unload()
 */
export async function unload(): Promise<void> {
  console.log('[IPQA] Unloading IPQA Alert Report plugin...');
}

// Ensure global functions for Goja runtime
// @ts-expect-error global scope
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
