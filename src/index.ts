import { fetchAllNodes } from './nodes.ts';
import { runRemoteTask } from './remote.ts';
import { registerScheduler, type ServerContext } from './scheduler.ts';

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

    const stdout = (res?.stdout || '').trim();
    if (stdout.includes('IPQA_PLUGIN_POC')) {
      console.log('[IPQA] Phase 0 PoC PASSED: admin:exec succeeded without 2FA interception.');
      return true;
    } else {
      console.warn(`[IPQA] Phase 0 PoC: unexpected output: "${stdout.slice(0, 100)}"`);
      return false;
    }
  } catch (err) {
    console.error('[IPQA] Phase 0 PoC FAILED: admin:exec was intercepted or failed:', err);
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
      '[IPQA] Phase 0 PoC failed (2FA interception or execution failure). Stopping plugin scheduling.'
    );
    return;
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
