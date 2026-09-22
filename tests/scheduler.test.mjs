import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { schedulerTick, runDailyReport } from '../src/scheduler.ts';
import { loadConfig } from '../src/config.ts';
import { getStateFilePath, saveState, INITIAL_STATE } from '../src/state.ts';

describe('scheduler.ts - Scheduler Due & Duplicate Prevention', () => {
  const testStorageDir = path.resolve(process.cwd(), 'storage');

  beforeEach(() => {
    saveState({ ...INITIAL_STATE });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testStorageDir)) {
        fs.rmSync(testStorageDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('Test 11: should prevent duplicate execution on the same Beijing date', async () => {
    let manifestExecCount = 0;
    let alertsExecCount = 0;
    let notificationCount = 0;

    const mockServer = {
      cron: () => {},
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
      }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [
            { uuid: 'n1', name: 'Node 1', weight: 1 },
          ];
        }
        if (method === 'admin:exec') {
          const cmd = params?.command || '';
          if (cmd.includes('__IPQA_MANIFEST_BEGIN__')) {
            manifestExecCount++;
          } else {
            alertsExecCount++;
          }
          return { task_id: 'task-123' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client_id: 'n1',
              status: 'completed',
              stdout: '__IPQA_STATUS__|OK\n2026-09-21 04:00:00|WARNING|Test|IPv4',
            },
          ];
        }
        if (method === 'admin:sendNotification') {
          notificationCount++;
          return { success: true };
        }
        return {};
      },
    };

    // 2026-09-20 23:00:00 UTC = 2026-09-21 07:00:00 BJT
    const dueTime = new Date('2026-09-20T23:00:00.000Z');

    // First tick -> should run both archive sync and alerts collection
    await schedulerTick(mockServer, dueTime);
    assert.equal(manifestExecCount, 1, 'First tick runs archive manifest sync');
    assert.equal(alertsExecCount, 1, 'First tick runs alerts.log collection');
    assert.equal(notificationCount, 1, 'First tick sends alert notification');

    // Second tick within 07:00-07:09 on same day -> should be skipped!
    const secondTickTime = new Date('2026-09-20T23:02:00.000Z');
    await schedulerTick(mockServer, secondTickTime);
    assert.equal(manifestExecCount, 1, 'manifest sync must not be called a second time');
    assert.equal(alertsExecCount, 1, 'alerts collection must not be called a second time');
    assert.equal(notificationCount, 1, 'sendNotification must not be called a second time');
  });

  it('should skip execution if daily retry limit (3) is reached', async () => {
    let execCount = 0;
    const dueTime = new Date('2026-09-20T23:00:00.000Z'); // 2026-09-21

    saveState({
      schema_version: 1,
      last_run_beijing_date: '',
      attempt_date: '2026-09-21',
      attempt_count: 3,
    });

    const mockServer = {
      cron: () => {},
      getConfig: () => ({ enabled: true }),
      call: async () => {
        execCount++;
        return {};
      },
    };

    await schedulerTick(mockServer, dueTime);
    assert.equal(execCount, 0, 'Must not execute when attempt_count >= 3');
  });

  // Section 5: Config defaults sync_archives to true when omitted
  it('Section 5: loadConfig defaults sync_archives to true when omitted from config', async () => {
    const config1 = await loadConfig({
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
      }),
    });
    assert.equal(config1.sync_archives, true, 'sync_archives must default to true when omitted');

    const config2 = await loadConfig({
      getConfig: () => ({}),
    });
    assert.equal(config2.sync_archives, true, 'sync_archives must default to true when config is empty');
  });

  // Section 6: 07:00 pre-report regression test verifying exact calling sequence
  it('Section 6: 07:00 pre-report regression test - executes archive sync before alerts and notification', async () => {
    const callSequence = [];

    const mockServer = {
      cron: () => {},
      // getConfig() without sync_archives
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
      }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [{ uuid: 'node-pre', name: 'Node Pre', weight: 1 }];
        }
        if (method === 'admin:exec') {
          const cmd = params?.command || '';
          if (cmd.includes('__IPQA_MANIFEST_BEGIN__')) {
            callSequence.push('archive_sync');
            return { task_id: 'task-manifest' };
          }
          if (cmd.includes('alerts.log')) {
            callSequence.push('alerts_collection');
            return { task_id: 'task-alerts' };
          }
          return { task_id: 'task-other' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          const tid = params?.task_id || params?.taskId;
          if (tid === 'task-manifest') {
            return [
              {
                client_id: 'node-pre',
                status: 'completed',
                stdout: '__IPQA_MANIFEST_BEGIN__\n__IPQA_MANIFEST_END__',
              },
            ];
          }
          if (tid === 'task-alerts') {
            return [
              {
                client_id: 'node-pre',
                status: 'completed',
                stdout: '__IPQA_STATUS__|OK\n2026-09-21 04:00:00|WARNING|Test warning|IPv4',
              },
            ];
          }
        }
        if (method === 'admin:sendNotification') {
          callSequence.push('notification');
          return { success: true };
        }
        return {};
      },
    };

    // 2026-09-20 23:00:00 UTC = 2026-09-21 07:00:00 BJT
    const at0700 = new Date('2026-09-20T23:00:00.000Z');
    await schedulerTick(mockServer, at0700);

    // Verify calling sequence strictly matches: archive sync -> alerts collection -> notification
    assert.deepEqual(callSequence, ['archive_sync', 'alerts_collection', 'notification']);
  });

  // Section 7: Daily sync regression test at 04:15 BJT without sync_archives in config
  it('Section 7: daily sync regression test - triggers daily archive sync at 04:15 BJT without sync_archives in config', async () => {
    let dailySyncTriggered = false;

    const mockServer = {
      cron: () => {},
      // config does NOT explicitly contain sync_archives
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
      }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [{ uuid: 'node-daily', name: 'Node Daily', weight: 1 }];
        }
        if (method === 'admin:exec') {
          const cmd = params?.command || '';
          if (cmd.includes('__IPQA_MANIFEST_BEGIN__')) {
            dailySyncTriggered = true;
          }
          return { task_id: 'task-daily' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client_id: 'node-daily',
              status: 'completed',
              stdout: '__IPQA_MANIFEST_BEGIN__\n__IPQA_MANIFEST_END__',
            },
          ];
        }
        return {};
      },
    };

    // 2026-09-20 20:15:00 UTC = 2026-09-21 04:15:00 BJT
    const at0415 = new Date('2026-09-20T20:15:00.000Z');
    await schedulerTick(mockServer, at0415);

    assert.equal(dailySyncTriggered, true, 'Daily archive sync must be triggered at 04:15 BJT by default');
  });

  // Section 8: Explicit disable allows disabling archive sync while keeping alerts report working
  it('Section 8: explicit disable allows disabling archive sync while keeping alerts report working', async () => {
    const executedActions = [];

    const mockServer = {
      cron: () => {},
      // explicitly disable sync_archives
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
        sync_archives: false,
      }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [{ uuid: 'node-disabled', name: 'Node Disabled', weight: 1 }];
        }
        if (method === 'admin:exec') {
          const cmd = params?.command || '';
          if (cmd.includes('__IPQA_MANIFEST_BEGIN__')) {
            executedActions.push('archive_sync');
          } else if (cmd.includes('alerts.log')) {
            executedActions.push('alerts_collection');
          }
          return { task_id: 'task-disabled' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client_id: 'node-disabled',
              status: 'completed',
              stdout: '__IPQA_STATUS__|OK\n2026-09-21 04:00:00|WARNING|Test alert|IPv4',
            },
          ];
        }
        if (method === 'admin:sendNotification') {
          executedActions.push('notification');
          return { success: true };
        }
        return {};
      },
    };

    // 1. At 04:15 BJT -> should NOT sync
    const at0415 = new Date('2026-09-20T20:15:00.000Z');
    await schedulerTick(mockServer, at0415);
    assert.deepEqual(executedActions, [], 'Must not execute any sync at 04:15 when sync_archives is false');

    // 2. At 07:00 BJT -> should NOT execute pre-report sync, but alerts collection and notification must execute
    const at0700 = new Date('2026-09-20T23:00:00.000Z');
    await schedulerTick(mockServer, at0700);
    assert.deepEqual(executedActions, ['alerts_collection', 'notification'], 'Must execute alerts report without archive sync');
  });
});
