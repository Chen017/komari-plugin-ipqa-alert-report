import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDailyReport, schedulerTick } from '../src/scheduler.ts';
import { runTestReport } from '../src/test.ts';
import { collectDailyNodeResults } from '../src/collection.ts';
import { filterAlerts, mergeAlerts, classifyLegacyAlertForDedupe } from '../src/ipqa.ts';
import { semanticChangesToAlerts, buildSemanticDedupeKey } from '../src/ipqa/archive-alerts.ts';
import { syncNodeArchives, syncIpqaArchives, determineNoUpdateStatus } from '../src/ipqa/archive-sync.ts';
import { calculateFreshness } from '../src/ipqa/freshness.ts';
import { saveDailyReport } from '../src/storage/archive-store.ts';
import { saveState, loadState, INITIAL_STATE, getStorageDir } from '../src/state.ts';

describe('Alert Unification & Stale Node Regression Test Suite', () => {
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

  // Case 1 — Theme has semantic change, alerts.log is empty
  it('Case 1: Theme has semantic change, alerts.log empty -> notification sent with alertCount=1', async () => {
    const nodeUuid = 'datawave-node';
    const dateKey = '2026-09-25';

    // Seed local paired daily report with CRITICAL semantic change (Theme source of truth)
    saveDailyReport(nodeUuid, {
      schemaVersion: 1,
      nodeUuid,
      date: dateKey,
      updatedAt: '2026-09-25T04:00:00Z',
      v4: {
        schemaVersion: 1,
        ipVersion: 'IPv4',
        archiveId: '2026-09-25_040000.json',
        date: dateKey,
        timestamp: '2026-09-25T04:00:00Z',
        info: { ip: '1.2.3.4' },
        scores: { ipapi: '18.16%' },
        type: { usage: {}, company: {} },
        factors: {},
        media: {},
        mail: {},
        extra: {},
      },
      v6: null,
      summary: {
        hasV4: true,
        hasV6: false,
        highestRiskCategory: 'Critical',
        highestRiskSource: 'ipapi',
        mediaSummary: {},
        aiSummary: {},
      },
      changesFromPrevious: [
        {
          date: dateKey,
          nodeUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'CRITICAL',
          field: 'scores.ipapi',
          before: '2.73%',
          after: '18.16%',
          beforeCategory: '较高风险',
          afterCategory: '极高风险',
          beforeRank: 2,
          afterRank: 4,
          description: 'ipapi 欺诈分剧烈恶化: [2.73%] (较高风险) -> [18.16%] (极高风险)',
        },
      ],
    });

    let notificationSent = false;
    let sentMessage = '';

    const mockServer = {
      cron: () => {},
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
        min_severity: 'WARNING',
        sync_archives: true,
      }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [{ uuid: nodeUuid, name: 'DataWave', weight: 1 }];
        }
        if (method === 'admin:exec') {
          return { task_id: 'task-c1' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          // alerts.log is completely empty!
          return [
            {
              client_id: nodeUuid,
              status: 'completed',
              stdout: '__IPQA_STATUS__|OK\n',
            },
          ];
        }
        if (method === 'admin:sendNotification') {
          notificationSent = true;
          sentMessage = params?.event?.message || params?.message || '';
          return { success: true };
        }
        return {};
      },
    };

    // Run at 07:00 BJT on 2026-09-25 (2026-09-24T23:00:00Z)
    const runTime = new Date('2026-09-24T23:00:00Z');
    await runDailyReport(mockServer, runTime);

    assert.strictEqual(notificationSent, true, 'Notification must be sent when Theme has semantic change');
    assert.ok(sentMessage.includes('DataWave'), 'Report must mention DataWave');
    assert.ok(sentMessage.includes('ipapi'), 'Report must include ipapi semantic change');
  });

  // Case 2 — semantic and legacy same event
  it('Case 2: semantic and legacy describe same event -> deduplicated into 1 alert', () => {
    const nodeUuid = 'node-dup';
    const dateKey = '2026-09-25';

    const dailyReport = {
      schemaVersion: 1,
      nodeUuid,
      date: dateKey,
      updatedAt: '2026-09-25T04:00:00Z',
      v4: {
        schemaVersion: 1,
        ipVersion: 'IPv4',
        archiveId: '2026-09-25_040000.json',
        date: dateKey,
        timestamp: '2026-09-25T04:00:00Z',
        info: {},
        scores: { IPQS: '85' },
        type: { usage: {}, company: {} },
        factors: {},
        media: {},
        mail: {},
        extra: {},
      },
      v6: null,
      summary: {
        hasV4: true,
        hasV6: false,
        highestRiskCategory: 'Critical',
        highestRiskSource: 'IPQS',
        mediaSummary: {},
        aiSummary: {},
      },
      changesFromPrevious: [
        {
          date: dateKey,
          nodeUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'CRITICAL',
          field: 'scores.IPQS',
          before: '0',
          after: '85',
          beforeCategory: '低风险',
          afterCategory: '极高风险',
          beforeRank: 0,
          afterRank: 4,
          description: 'IPQS 欺诈分剧烈恶化: [0] (低风险) -> [85] (极高风险)',
        },
      ],
    };

    const semanticAlerts = semanticChangesToAlerts(nodeUuid, dailyReport);
    assert.strictEqual(semanticAlerts.length, 1);

    const rawLegacyAlerts = [
      {
        timestamp: '2026-09-25 04:05:00',
        level: 'CRITICAL',
        message: 'IPQS 风险等级上升至 [极高风险] (原: [低风险], 评分: 0 -> 85)',
        ipVersion: 'IPv4',
        raw: '2026-09-25 04:05:00|CRITICAL|IPQS 风险等级上升至 [极高风险] (原: [低风险], 评分: 0 -> 85)|IPv4',
        source: 'alerts_log',
      },
    ];

    const mergeRes = mergeAlerts(nodeUuid, semanticAlerts, rawLegacyAlerts);
    assert.strictEqual(mergeRes.merged.length, 1, 'Overlapping legacy alert must be suppressed');
    assert.strictEqual(mergeRes.deduplicatedCount, 1, 'deduplicatedCount must be 1');
    assert.strictEqual(mergeRes.merged[0].source, 'archive_diff', 'Semantic alert must take priority');
  });

  // Case 3 — legacy supplemental event not removed
  it('Case 3: legacy supplemental event (expected region mismatch) is not removed', () => {
    const nodeUuid = 'node-supp';
    const semanticAlerts = [];
    const rawLegacyAlerts = [
      {
        timestamp: '2026-09-25 04:02:00',
        level: 'WARNING',
        message: 'YouTube 地区 [US] 不符合预期 [JP]',
        ipVersion: 'IPv4',
        raw: '2026-09-25 04:02:00|WARNING|YouTube 地区 [US] 不符合预期 [JP]|IPv4',
        source: 'alerts_log',
      },
    ];

    const mergeRes = mergeAlerts(nodeUuid, semanticAlerts, rawLegacyAlerts);
    assert.strictEqual(mergeRes.merged.length, 1);
    assert.strictEqual(mergeRes.merged[0].message, 'YouTube 地区 [US] 不符合预期 [JP]');
  });

  // Case 4 — DNSBL legacy event kept
  it('Case 4: DNSBL legacy event is kept and triggers notification', () => {
    const nodeUuid = 'node-dnsbl';
    const rawLegacyAlerts = [
      {
        timestamp: '2026-09-25 04:03:00',
        level: 'WARNING',
        message: 'DNS 黑名单拦截数增加 (从 0 增至 3)',
        ipVersion: 'IPv4',
        raw: '2026-09-25 04:03:00|WARNING|DNS 黑名单拦截数增加 (从 0 增至 3)|IPv4',
        source: 'alerts_log',
      },
    ];

    const mergeRes = mergeAlerts(nodeUuid, [], rawLegacyAlerts);
    const filterRes = filterAlerts(mergeRes.merged, {
      enabled: true,
      all_nodes: true,
      nodes: [],
      min_severity: 'WARNING',
      ignore_initial_archive: true,
      notify_collection_failures: true,
      template: '',
    });

    assert.strictEqual(filterRes.kept, 1);
    assert.strictEqual(filterRes.alerts[0].message, 'DNS 黑名单拦截数增加 (从 0 增至 3)');
  });

  // Case 5 — min_severity applied consistently to both sources
  it('Case 5: min_severity applies consistently to semantic diff and legacy sources', () => {
    const config = {
      enabled: true,
      all_nodes: true,
      nodes: [],
      min_severity: 'WARNING',
      ignore_initial_archive: true,
      notify_collection_failures: true,
      template: '',
    };

    const alerts = [
      {
        timestamp: '2026-09-25 04:00:00',
        level: 'INFO',
        message: 'Semantic info alert',
        ipVersion: 'IPv4',
        raw: 'sem-info',
        source: 'archive_diff',
      },
      {
        timestamp: '2026-09-25 04:00:01',
        level: 'WARNING',
        message: 'Semantic warning alert',
        ipVersion: 'IPv4',
        raw: 'sem-warn',
        source: 'archive_diff',
      },
      {
        timestamp: '2026-09-25 04:00:02',
        level: 'INFO',
        message: 'Legacy info alert',
        ipVersion: 'IPv4',
        raw: 'leg-info',
        source: 'alerts_log',
      },
      {
        timestamp: '2026-09-25 04:00:03',
        level: 'CRITICAL',
        message: 'Legacy critical alert',
        ipVersion: 'IPv4',
        raw: 'leg-crit',
        source: 'alerts_log',
      },
    ];

    const filterRes = filterAlerts(alerts, config);
    assert.strictEqual(filterRes.kept, 2);
    assert.strictEqual(filterRes.below_severity, 2);

    const levels = filterRes.alerts.map(a => a.level);
    assert.deepStrictEqual(levels, ['CRITICAL', 'WARNING']);
    assert.strictEqual(filterRes.alerts[0].message, 'Legacy critical alert');
    assert.strictEqual(filterRes.alerts[1].message, 'Semantic warning alert');
  });

  // Case 6 — sync_archives=false
  it('Case 6: sync_archives=false maintains alerts.log-only behavior without reading daily archive', async () => {
    const nodeUuid = 'node-nosync';
    const dateKey = '2026-09-25';

    // Seed local archive that should NOT be read when sync_archives is false
    saveDailyReport(nodeUuid, {
      schemaVersion: 1,
      nodeUuid,
      date: dateKey,
      updatedAt: '2026-09-25T04:00:00Z',
      v4: null,
      v6: null,
      summary: { hasV4: false, hasV6: false, highestRiskCategory: 'Critical', highestRiskSource: '', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: [
        {
          date: dateKey,
          nodeUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'CRITICAL',
          field: 'scores.ipapi',
          before: '1%',
          after: '99%',
          description: 'Should not appear when sync_archives=false',
        },
      ],
    });

    const mockServer = {
      cron: () => {},
      call: async (method) => {
        if (method === 'admin:exec') return { task_id: 'task-nosync' };
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client_id: nodeUuid,
              status: 'completed',
              stdout: '__IPQA_STATUS__|OK\n2026-09-25 04:00:00|WARNING|Legacy Only Alert|IPv4',
            },
          ];
        }
        return {};
      },
    };

    const results = await collectDailyNodeResults({
      server: mockServer,
      targets: [{ uuid: nodeUuid, name: 'Node NoSync', weight: 1 }],
      config: {
        enabled: true,
        all_nodes: true,
        nodes: [],
        min_severity: 'INFO',
        ignore_initial_archive: true,
        notify_collection_failures: true,
        template: '',
        sync_archives: false, // explicitly false
      },
      dateKey,
      startEpoch: 1758758400,
      endEpoch: 1758783659,
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].alerts.length, 1);
    assert.strictEqual(results[0].alerts[0].message, 'Legacy Only Alert');
  });

  // Case 7 — Zouter stale does not block DataWave / Vmiss
  it('Case 7: Zouter stale does not block DataWave and Vmiss notifications, not marked as failed', async () => {
    const zouterUuid = 'zouter-uuid';
    const datawaveUuid = 'datawave-uuid';
    const vmissUuid = 'vmiss-uuid';
    const dateKey = '2026-09-25';

    // Seed DataWave today archive with CRITICAL change
    saveDailyReport(datawaveUuid, {
      schemaVersion: 1,
      nodeUuid: datawaveUuid,
      date: dateKey,
      updatedAt: '2026-09-25T04:00:00Z',
      v4: null,
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Critical', highestRiskSource: 'ipapi', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: [
        {
          date: dateKey,
          nodeUuid: datawaveUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'CRITICAL',
          field: 'scores.ipapi',
          before: '2.73%',
          after: '18.16%',
          description: 'DataWave ipapi CRITICAL risk change',
        },
      ],
    });

    // Seed Vmiss today archive with WARNING change
    saveDailyReport(vmissUuid, {
      schemaVersion: 1,
      nodeUuid: vmissUuid,
      date: dateKey,
      updatedAt: '2026-09-25T04:00:00Z',
      v4: null,
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'High', highestRiskSource: 'IPQS', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: [
        {
          date: dateKey,
          nodeUuid: vmissUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'WARNING',
          field: 'scores.IPQS',
          before: '10',
          after: '50',
          description: 'Vmiss IPQS WARNING risk change',
        },
      ],
    });

    // Zouter has NO report for 2026-09-25 (only yesterday 2026-09-24)
    saveDailyReport(zouterUuid, {
      schemaVersion: 1,
      nodeUuid: zouterUuid,
      date: '2026-09-24',
      updatedAt: '2026-09-24T04:00:00Z',
      v4: null,
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Low', highestRiskSource: 'None', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: [],
    });

    let notificationSent = false;
    let sentMessage = '';

    const mockServer = {
      cron: () => {},
      getConfig: () => ({
        enabled: true,
        all_nodes: true,
        min_severity: 'WARNING',
        sync_archives: true,
      }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [
            { uuid: zouterUuid, name: 'Zouter', weight: 1 },
            { uuid: datawaveUuid, name: 'DataWave', weight: 2 },
            { uuid: vmissUuid, name: 'Vmiss', weight: 3 },
          ];
        }
        if (method === 'admin:exec') {
          return { task_id: 'task-c7' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            { client_id: zouterUuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' },
            { client_id: datawaveUuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' },
            { client_id: vmissUuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' },
          ];
        }
        if (method === 'admin:sendNotification') {
          notificationSent = true;
          sentMessage = params?.event?.message || params?.message || '';
          return { success: true };
        }
        return {};
      },
    };

    const runTime = new Date('2026-09-24T23:00:00Z'); // 2026-09-25 07:00 BJT
    await runDailyReport(mockServer, runTime);

    assert.strictEqual(notificationSent, true, 'Notification must be sent for DataWave and Vmiss');
    assert.ok(sentMessage.includes('DataWave'), 'Report must include DataWave');
    assert.ok(sentMessage.includes('Vmiss'), 'Report must include Vmiss');
    assert.ok(!sentMessage.includes('❌ 采集异常'), 'Zouter must not be listed as collection failure');
  });

  // Case 8 — pending_today at 04:30 BJT
  it('Case 8: pending_today at 04:30 BJT when latest archive is yesterday', () => {
    // 2026-09-25 04:30 BJT = 2026-09-24 20:30 UTC
    const time0430 = new Date('2026-09-24T20:30:00Z');
    const status = determineNoUpdateStatus('2026-09-24', time0430);
    assert.strictEqual(status, 'pending_today');
  });

  // Case 9 — stale boundary at 05:01 BJT
  it('Case 9: stale at 05:01 BJT when latest archive is yesterday', () => {
    // 2026-09-25 05:01 BJT = 2026-09-24 21:01 UTC
    const time0501 = new Date('2026-09-24T21:01:00Z');
    const status = determineNoUpdateStatus('2026-09-24', time0501);
    assert.strictEqual(status, 'stale');
  });

  // Case 10 — current date archive
  it('Case 10: current / already_current when latest archive is today at 05:01 BJT', () => {
    const time0501 = new Date('2026-09-24T21:01:00Z');
    const status = determineNoUpdateStatus('2026-09-25', time0501);
    assert.strictEqual(status, 'already_current');
  });

  // Case 11 — no archive
  it('Case 11: no_archive status when node has no archive records', () => {
    const time0501 = new Date('2026-09-24T21:01:00Z');
    const status = determineNoUpdateStatus(null, time0501);
    assert.strictEqual(status, 'no_archive');
  });

  // Case 12 — 07:00 calling sequence
  it('Case 12: 07:00 calling sequence strictly matches pre-report sync -> local read & remote alerts -> notification', async () => {
    const sequence = [];
    const nodeUuid = 'node-seq';

    saveDailyReport(nodeUuid, {
      schemaVersion: 1,
      nodeUuid,
      date: '2026-09-25',
      updatedAt: '2026-09-25T04:00:00Z',
      v4: null,
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Critical', highestRiskSource: 'ipapi', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: [
        {
          date: '2026-09-25',
          nodeUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'CRITICAL',
          field: 'scores.ipapi',
          before: '1%',
          after: '50%',
          description: 'Sequence test change',
        },
      ],
    });

    const mockServer = {
      cron: () => {},
      getConfig: () => ({ enabled: true, all_nodes: true, min_severity: 'WARNING', sync_archives: true }),
      call: async (method, params) => {
        if (method === 'common:getNodes') {
          return [{ uuid: nodeUuid, name: 'Node Seq', weight: 1 }];
        }
        if (method === 'admin:exec') {
          const cmd = params?.command || '';
          if (cmd.includes('__IPQA_MANIFEST_BEGIN__')) {
            sequence.push('pre_report_sync');
            return { task_id: 'task-sync' };
          }
          if (cmd.includes('alerts.log')) {
            sequence.push('alerts_collection');
            return { task_id: 'task-alerts' };
          }
          return { task_id: 'task-other' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          const tid = params?.task_id || params?.taskId;
          if (tid === 'task-sync') {
            return [{ client_id: nodeUuid, status: 'completed', stdout: '__IPQA_MANIFEST_BEGIN__\n__IPQA_MANIFEST_END__' }];
          }
          if (tid === 'task-alerts') {
            return [{ client_id: nodeUuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' }];
          }
        }
        if (method === 'admin:sendNotification') {
          sequence.push('send_notification');
          return { success: true };
        }
        return {};
      },
    };

    const at0700 = new Date('2026-09-24T23:00:00Z');
    await runDailyReport(mockServer, at0700);

    assert.deepStrictEqual(sequence, ['pre_report_sync', 'alerts_collection', 'send_notification']);
  });

  // Case 13 — same day only executes once
  it('Case 13: same Beijing date execution happens at most once', async () => {
    let callCount = 0;
    const mockServer = {
      cron: () => {},
      getConfig: () => ({ enabled: true, all_nodes: true }),
      call: async (method) => {
        if (method === 'common:getNodes') return [];
        return {};
      },
    };

    const at0700 = new Date('2026-09-24T23:00:00Z'); // 2026-09-25 07:00 BJT
    await runDailyReport(mockServer, at0700);

    const state = loadState();
    assert.strictEqual(state.last_run_beijing_date, '2026-09-25');

    // Second run should be a complete no-op
    let secondRunCalled = false;
    mockServer.call = async () => {
      secondRunCalled = true;
      return {};
    };

    await runDailyReport(mockServer, at0700);
    assert.strictEqual(secondRunCalled, false, 'Second run on same day must be skipped');
  });

  // Case 14 — sendNotification failure does not mark state as success
  it('Case 14: sendNotification failure increments attempt_count and does not mark last_run_beijing_date', async () => {
    const nodeUuid = 'node-err';
    const dateKey = '2026-09-25';

    saveDailyReport(nodeUuid, {
      schemaVersion: 1,
      nodeUuid,
      date: dateKey,
      updatedAt: '2026-09-25T04:00:00Z',
      v4: null,
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Critical', highestRiskSource: 'ipapi', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: [
        {
          date: dateKey,
          nodeUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'CRITICAL',
          field: 'scores.ipapi',
          before: '1%',
          after: '50%',
          description: 'Error test change',
        },
      ],
    });

    const mockServer = {
      cron: () => {},
      getConfig: () => ({ enabled: true, all_nodes: true, min_severity: 'INFO', sync_archives: true }),
      call: async (method) => {
        if (method === 'common:getNodes') return [{ uuid: nodeUuid, name: 'Node Err', weight: 1 }];
        if (method === 'admin:exec') return { task_id: 'task-e' };
        if (method === 'admin:getTaskResultsByTaskId') {
          return [{ client_id: nodeUuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' }];
        }
        if (method === 'admin:sendNotification') {
          throw new Error('Telegram network error');
        }
        return {};
      },
    };

    const at0700 = new Date('2026-09-24T23:00:00Z');
    await assert.rejects(async () => {
      await runDailyReport(mockServer, at0700);
    }, /Telegram network error/);

    const state = loadState();
    assert.strictEqual(state.last_run_beijing_date, '', 'last_run_beijing_date must not be marked success');
    assert.strictEqual(state.attempt_count, 1, 'attempt_count must be incremented');
  });

  // Case 15 — manual test and scheduled report parity
  it('Case 15: manual test (today_0700) and scheduled daily report yield identical results on same fixture', async () => {
    const nodeUuid = 'node-parity';
    const dateKey = '2026-09-25';

    saveDailyReport(nodeUuid, {
      schemaVersion: 1,
      nodeUuid,
      date: dateKey,
      updatedAt: '2026-09-25T04:00:00Z',
      v4: null,
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Critical', highestRiskSource: 'ipapi', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: [
        {
          date: dateKey,
          nodeUuid,
          ipVersion: 'IPv4',
          category: 'score',
          severity: 'CRITICAL',
          field: 'scores.ipapi',
          before: '2%',
          after: '20%',
          description: 'Parity score change',
        },
      ],
    });

    const mockServer = {
      cron: () => {},
      getConfig: () => ({ enabled: true, all_nodes: true, min_severity: 'WARNING', sync_archives: true }),
      call: async (method) => {
        if (method === 'common:getNodes') return [{ uuid: nodeUuid, name: 'Node Parity', weight: 1 }];
        if (method === 'admin:exec') return { task_id: 'task-p' };
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client_id: nodeUuid,
              status: 'completed',
              stdout: '__IPQA_STATUS__|OK\n2026-09-25 04:00:00|WARNING|Supplemental Event|IPv4',
            },
          ];
        }
        if (method === 'admin:sendNotification') return { success: true };
        return {};
      },
    };

    const runTime = new Date('2026-09-24T23:00:00Z'); // 2026-09-25 07:00 BJT

    // 1. Run manual test with 'today_0700'
    const testResult = await runTestReport(mockServer, { window: 'today_0700' }, runTime);

    // 2. Run scheduled daily report
    await runDailyReport(mockServer, runTime);
    const state = loadState();

    assert.strictEqual(testResult.alertCount, 2, 'Manual test should see 2 alerts (1 semantic + 1 supplemental)');
    assert.strictEqual(state.last_summary?.alerts, 2, 'Scheduled report should see exactly the same 2 alerts');
    assert.strictEqual(testResult.criticalCount, 1);
    assert.strictEqual(testResult.warningCount, 1);
  });

  // Case 16 — raw=1 filtered=0 explainable
  it('Case 16: raw=1 filtered=0 log counts are transparent and explainable', () => {
    const rawLegacyAlerts = [
      {
        timestamp: '2026-09-25 04:00:00',
        level: 'INFO',
        message: 'Low severity notice',
        ipVersion: 'IPv4',
        raw: '2026-09-25 04:00:00|INFO|Low severity notice|IPv4',
        source: 'alerts_log',
      },
    ];

    const mergeRes = mergeAlerts('node-explain', [], rawLegacyAlerts);
    const filterRes = filterAlerts(mergeRes.merged, {
      enabled: true,
      all_nodes: true,
      nodes: [],
      min_severity: 'WARNING',
      ignore_initial_archive: true,
      notify_collection_failures: true,
      template: '',
    });

    assert.strictEqual(mergeRes.legacyRawCount, 1);
    assert.strictEqual(filterRes.kept, 0);
    assert.strictEqual(filterRes.below_severity, 1);
  });
});
