import type { TaskExecResult } from './types.ts';

/**
 * Builds the strictly read-only shell command to inspect IPQA alerts.
 * Uses integer epochs to avoid injection.
 */
export function buildIpqaReadCommand(startEpoch: number, endEpoch: number): string {
  const safeStart = Math.floor(startEpoch);
  const safeEnd = Math.floor(endEpoch);

  if (!Number.isFinite(safeStart) || !Number.isFinite(safeEnd)) {
    throw new Error(`Invalid epochs: startEpoch=${startEpoch}, endEpoch=${endEpoch}`);
  }

  return `set -u
START_EPOCH="${safeStart}"
END_EPOCH="${safeEnd}"

IPQA_HOME="\${IPQA_DIR:-$HOME/.ipqa}"
ALERT_LOG="$IPQA_HOME/data/alerts.log"

if [ ! -f "$ALERT_LOG" ]; then
    printf '%s\\n' '__IPQA_STATUS__|NOT_FOUND'
    exit 0
fi

if [ ! -r "$ALERT_LOG" ]; then
    printf '%s\\n' '__IPQA_STATUS__|READ_FAILED'
    exit 0
fi

START_LOCAL=$(date -d "@$START_EPOCH" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || {
    printf '%s\\n' '__IPQA_STATUS__|DATE_CONVERSION_FAILED'
    exit 0
}

END_LOCAL=$(date -d "@$END_EPOCH" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || {
    printf '%s\\n' '__IPQA_STATUS__|DATE_CONVERSION_FAILED'
    exit 0
}

printf '%s\\n' '__IPQA_STATUS__|OK'

awk -F'|' \\
    -v start="$START_LOCAL" \\
    -v end="$END_LOCAL" '
        $1 >= start && $1 <= end { print }
    ' "$ALERT_LOG"
`;
}

/**
 * Helper sleep function.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalizes raw task results returned from `admin:getTaskResultsByTaskId`.
 * Supports various field namings across Komari server versions.
 */
export function normalizeTaskResults(rawResults: unknown): Map<string, TaskExecResult> {
  const map = new Map<string, TaskExecResult>();
  if (!rawResults) return map;

  const extractItem = (obj: Record<string, unknown>, fallbackKey = '') => {
    const clientId = String(
      obj.client_id ||
      obj.client_uuid ||
      obj.clientId ||
      obj.client ||
      obj.uuid ||
      obj.node_id ||
      obj.nodeId ||
      obj.id ||
      fallbackKey
    );

    const stdout =
      typeof obj.stdout === 'string'
        ? obj.stdout
        : typeof obj.output === 'string'
        ? obj.output
        : typeof obj.result === 'string'
        ? obj.result
        : '';

    const stderr =
      typeof obj.stderr === 'string'
        ? obj.stderr
        : typeof obj.error_output === 'string'
        ? obj.error_output
        : '';

    const exitCode =
      typeof obj.exit_code === 'number'
        ? obj.exit_code
        : typeof obj.exitCode === 'number'
        ? obj.exitCode
        : typeof obj.code === 'number'
        ? obj.code
        : null;

    const finishedAt =
      typeof obj.finished_at === 'string'
        ? obj.finished_at
        : typeof obj.finishedAt === 'string'
        ? obj.finishedAt
        : null;

    const status =
      typeof obj.status === 'string'
        ? obj.status
        : typeof obj.state === 'string'
        ? obj.state
        : undefined;

    const success = typeof obj.success === 'boolean' ? obj.success : undefined;
    const error =
      typeof obj.error === 'string'
        ? obj.error
        : typeof obj.errorMessage === 'string'
        ? obj.errorMessage
        : undefined;

    if (clientId) {
      map.set(clientId, {
        ...obj,

        client_id: clientId,
        stdout,
        stderr,
        exit_code: exitCode,
        finished_at: finishedAt,
        status,
        success,
        error,
      });
    }
  };

  if (Array.isArray(rawResults)) {
    for (const item of rawResults) {
      if (!item || typeof item !== 'object') continue;
      extractItem(item as Record<string, unknown>);
    }
  } else if (typeof rawResults === 'object') {
    for (const [key, val] of Object.entries(rawResults as Record<string, unknown>)) {
      if (typeof val === 'string') {
        extractItem({ stdout: val }, key);
      } else if (val && typeof val === 'object') {
        extractItem(val as Record<string, unknown>, key);
      }
    }
  }

  return map;
}

/**
 * Checks if a task result for a given node is terminal (finished).
 */
export function isTerminalResult(res?: TaskExecResult): boolean {
  if (!res) return false;

  // Native Komari completion signal.
  if (typeof res.exit_code === 'number') {
    return true;
  }

  // Secondary native completion signal.
  if (
    typeof res.finished_at === 'string' &&
    res.finished_at.trim() !== ''
  ) {
    return true;
  }

  // Synthetic / compatibility terminal states.
  if (typeof res.status === 'string') {
    const s = res.status.toLowerCase();

    if (
      s === 'completed' ||
      s === 'finished' ||
      s === 'failed' ||
      s === 'error' ||
      s === 'timeout'
    ) {
      return true;
    }

    if (
      s === 'running' ||
      s === 'queued' ||
      s === 'pending'
    ) {
      return false;
    }
  }

  if (res.error) {
    return true;
  }

  return false;
}

/**
 * Dispatches command to clients and polls for results until deadline.
 */
export async function runRemoteTask(
  server: { call: (method: string, params?: unknown) => Promise<unknown> },
  command: string,
  targetUuids: string[],
  timeoutMs = 30_000,
  pollIntervalMs = 1_000
): Promise<{ taskId: string; results: Map<string, TaskExecResult> }> {
  const execRes = (await server.call('admin:exec', {
    command,
    clients: targetUuids,
  })) as { task_id?: string; taskId?: string } | undefined;

  const taskId = String(execRes?.task_id || execRes?.taskId || '');
  if (!taskId) {
    throw new Error('Failed to obtain task_id from admin:exec');
  }

  console.log(`[IPQA] task submitted: ${taskId}`);

  const results = new Map<string, TaskExecResult>();
  const deadline = Date.now() + timeoutMs;
  let loggedStructure = false;

  while (Date.now() < deadline) {
    try {
      const raw = await server.call('admin:getTaskResultsByTaskId', {
        task_id: taskId,
      });

      if (!loggedStructure && raw) {
        loggedStructure = true;
        // Section 10.3: 输出一次脱敏后的 TaskResult 结构到插件日志
        try {
          const sample = Array.isArray(raw)
            ? raw[0]
            : typeof raw === 'object'
            ? Object.values(raw as Record<string, unknown>)[0]
            : null;
          if (sample && typeof sample === 'object') {
            console.log(
              `[IPQA] TaskResult structure: keys=[${Object.keys(sample as Record<string, unknown>).join(', ')}]`
            );
          }
        } catch {
          // ignore
        }
      }

      const currentMap = normalizeTaskResults(raw);
      for (const [uuid, r] of currentMap.entries()) {
        results.set(uuid, r);
        console.log(
          `[IPQA] TaskResult state: client=${uuid}, exit_code=${r.exit_code}, finished=${isTerminalResult(r)}, output_len=${(r.stdout || '').length}`
        );
      }

      // Check if all targets have terminal results
      const allDone = targetUuids.every(uuid => isTerminalResult(results.get(uuid)));
      if (allDone) {
        break;
      }
    } catch (err) {
      console.warn(`[IPQA] Error polling task ${taskId}:`, err);
    }

    await sleep(pollIntervalMs);
  }

  const timeoutSeconds = Math.round(timeoutMs / 1000);

  // Handle any nodes that timed out
  for (const uuid of targetUuids) {
    const res = results.get(uuid);
    if (!res || !isTerminalResult(res)) {
      results.set(uuid, {
        client_id: uuid,
        status: 'TIMEOUT',
        error: `Agent task timeout after ${timeoutSeconds}s`,
      });
    }
  }

  return { taskId, results };
}
