import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { schedulerTick, runDailyReport } from '../src/scheduler.ts';
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
    let execCount = 0;
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
          execCount++;
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

    // First tick -> should run
    await schedulerTick(mockServer, dueTime);
    assert.equal(execCount, 1);
    assert.equal(notificationCount, 1);

    // Second tick within 07:00-07:09 on same day -> should be skipped!
    const secondTickTime = new Date('2026-09-20T23:02:00.000Z');
    await schedulerTick(mockServer, secondTickTime);
    assert.equal(execCount, 1, 'admin:exec must not be called a second time');
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
});
