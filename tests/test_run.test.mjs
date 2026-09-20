import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTestReport, getTestWindow } from '../src/test.ts';
import { saveState, loadState, INITIAL_STATE } from '../src/state.ts';

describe('test.ts - Manual Test Run', () => {
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

  it('should calculate correct test windows for different modes', () => {
    const fixedNow = new Date('2026-09-20T10:30:00.000Z'); // 18:30 BJT
    const wNow = getTestWindow('today_now', fixedNow);
    assert.equal(wNow.dateKey, '2026-09-20');
    assert.ok(wNow.windowStart.includes('2026-09-20 00:00:00'));

    const w0700 = getTestWindow('today_0700', fixedNow);
    assert.equal(w0700.windowStart, '2026-09-20 00:00:00');
    assert.equal(w0700.windowEnd, '2026-09-20 07:00:59');

    const w24h = getTestWindow('last_24h', fixedNow);
    assert.equal(w24h.endEpoch - w24h.startEpoch, 86400);
  });

  it('should collect logs and send notification when alerts exist', async () => {
    let execCount = 0;
    let notificationCount = 0;
    let sentMessage = '';

    const mockServer = {
      cron: () => {},
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
        min_severity: 'INFO',
      }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [{ uuid: 'node-1', name: 'Tokyo VPS', weight: 1 }];
        }
        if (method === 'admin:exec') {
          execCount++;
          return { task_id: 'task-test-1' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client_id: 'node-1',
              status: 'completed',
              stdout:
                '__IPQA_STATUS__|OK\n2026-09-20 04:10:00|WARNING|IP 欺诈分由 0 变更为 45|IPv4\n2026-09-20 04:10:05|CRITICAL|Netflix 解锁失效|IPv4',
            },
          ];
        }
        if (method === 'admin:sendNotification') {
          notificationCount++;
          sentMessage = params?.event?.message || params?.message || '';
          return { success: true };
        }
        return {};
      },
    };

    const res = await runTestReport(mockServer, { window: 'today_now' });

    assert.equal(res.success, true);
    assert.equal(execCount, 1);
    assert.equal(notificationCount, 1);
    assert.equal(res.notificationSent, true);
    assert.equal(res.alertCount, 2);
    assert.equal(res.criticalCount, 1);
    assert.equal(res.warningCount, 1);
    assert.ok(sentMessage.includes('Tokyo VPS'));
    assert.ok(sentMessage.includes('Netflix 解锁失效'));

    // Verify scheduled state was NOT touched
    const state = loadState();
    assert.equal(state.last_run_beijing_date, '', 'Test run must not modify last_run_beijing_date');
  });

  it('should not send notification when no alerts exist (unless forceSend is true)', async () => {
    let notificationCount = 0;

    const mockServer = {
      cron: () => {},
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
      }),
      call: async (method) => {
        if (method === 'common:getNodes') {
          return [{ uuid: 'node-2', name: 'US VPS', weight: 1 }];
        }
        if (method === 'admin:exec') {
          return { task_id: 'task-test-2' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client_id: 'node-2',
              status: 'completed',
              stdout: '__IPQA_STATUS__|OK\n',
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

    // 1. Without forceSend -> no notification
    const res1 = await runTestReport(mockServer, { forceSend: false });
    assert.equal(res1.success, true);
    assert.equal(res1.alertCount, 0);
    assert.equal(res1.notificationSent, false);
    assert.equal(notificationCount, 0);
    assert.ok(res1.notificationSkippedReason?.includes('无告警'));

    // 2. With forceSend -> notification is sent
    const res2 = await runTestReport(mockServer, { forceSend: true });
    assert.equal(res2.success, true);
    assert.equal(res2.notificationSent, true);
    assert.equal(notificationCount, 1);
  });

  it('should return error if no target nodes are configured', async () => {
    const mockServer = {
      cron: () => {},
      getConfig: () => ({
        enabled: true,
        all_nodes: false,
        nodes: [],
      }),
      call: async (method) => {
        if (method === 'common:getNodes') {
          return [{ uuid: 'node-1', name: 'Node 1', weight: 1 }];
        }
        return {};
      },
    };

    const res = await runTestReport(mockServer);
    assert.equal(res.success, false);
    assert.ok(res.message.includes('未找到任何目标节点'));
  });
});
