import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runDailyReport } from '../src/scheduler.ts';
import { runTestReport } from '../src/test.ts';
import { collectDailyNodeResults } from '../src/collection.ts';
import { filterAlerts, mergeAlerts } from '../src/ipqa.ts';
import { semanticChangesToAlerts } from '../src/ipqa/archive-alerts.ts';
import { determineNoUpdateStatus } from '../src/ipqa/archive-sync.ts';
import { saveDailyReport } from '../src/storage/archive-store.ts';
import { saveState, loadState, INITIAL_STATE } from '../src/state.ts';

// -----------------------------------------------------------------------------
// Test Fixture Factories
// -----------------------------------------------------------------------------

function makeNode(overrides = {}) {
  return {
    uuid: 'node-1',
    name: 'Node 1',
    weight: 1,
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    all_nodes: true,
    nodes: [],
    min_severity: 'WARNING',
    ignore_initial_archive: true,
    notify_collection_failures: true,
    sync_archives: true,
    template: '',
    ...overrides,
  };
}

function makeSemanticChange(overrides = {}) {
  return {
    date: '2026-09-25',
    nodeUuid: 'node-1',
    ipVersion: 'IPv4',
    category: 'score',
    severity: 'CRITICAL',
    field: 'scores.ipapi',
    before: '2.73%',
    after: '18.16%',
    description: 'Score changed',
    ...overrides,
  };
}

function makeDailyReport({
  nodeUuid = 'node-1',
  date = '2026-09-25',
  timestamp = '2026-09-25T04:00:00Z',
  changes = [],
  summaryOverrides = {},
} = {}) {
  return {
    schemaVersion: 1,
    nodeUuid,
    date,
    updatedAt: timestamp,
    v4: {
      schemaVersion: 1,
      ipVersion: 'IPv4',
      archiveId: `${date}_040000.json`,
      date,
      timestamp,
      info: { ip: '1.2.3.4' },
      scores: {},
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
      ...summaryOverrides,
    },
    changesFromPrevious: changes,
  };
}

function seedDailyReport(nodeUuid, options = {}) {
  const report = makeDailyReport({ nodeUuid, ...options });
  saveDailyReport(nodeUuid, report);
  return report;
}

function makeMockServer({
  nodes = [makeNode()],
  config = {},
  taskResults = [],
  onNotification,
  execCallback,
} = {}) {
  const fullConfig = makeConfig(config);
  return {
    cron: () => {},
    getConfig: () => fullConfig,
    call: async (method, params) => {
      if (method === 'common:getNodes') return nodes;
      if (method === 'admin:exec') {
        if (execCallback) return execCallback(params);
        return { task_id: 'task-mock' };
      }
      if (method === 'admin:getTaskResultsByTaskId') {
        return typeof taskResults === 'function' ? taskResults(params) : taskResults;
      }
      if (method === 'admin:sendNotification') {
        if (onNotification) onNotification(params);
        return { success: true };
      }
      return {};
    },
  };
}

// -----------------------------------------------------------------------------
// Test Suite
// -----------------------------------------------------------------------------

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
    const node = makeNode({ uuid: 'datawave-node', name: 'DataWave' });
    const dateKey = '2026-09-25';

    seedDailyReport(node.uuid, {
      date: dateKey,
      changes: [
        makeSemanticChange({
          nodeUuid: node.uuid,
          date: dateKey,
          description: 'ipapi 欺诈分剧烈恶化: [2.73%] (较高风险) -> [18.16%] (极高风险)',
        }),
      ],
    });

    let notificationSent = false;
    let sentMessage = '';
    const mockServer = makeMockServer({
      nodes: [node],
      taskResults: [{ client_id: node.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' }],
      onNotification: (params) => {
        notificationSent = true;
        sentMessage = params?.event?.message || params?.message || '';
      },
    });

    await runDailyReport(mockServer, new Date('2026-09-24T23:00:00Z'));
    assert.strictEqual(notificationSent, true, 'Notification must be sent when Theme has semantic change');
    assert.ok(sentMessage.includes('DataWave'), 'Report must mention DataWave');
    assert.ok(sentMessage.includes('ipapi'), 'Report must include ipapi semantic change');
  });

  // Case 2 — semantic and legacy same event
  it('Case 2: semantic and legacy describe same event -> deduplicated into 1 alert', () => {
    const nodeUuid = 'node-dup';
    const dateKey = '2026-09-25';
    const dailyReport = makeDailyReport({
      nodeUuid,
      date: dateKey,
      changes: [
        makeSemanticChange({
          nodeUuid,
          date: dateKey,
          field: 'scores.IPQS',
          description: 'IPQS 欺诈分剧烈恶化: [0] (低风险) -> [85] (极高风险)',
        }),
      ],
    });

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

    const mergeRes = mergeAlerts('node-supp', [], rawLegacyAlerts);
    assert.strictEqual(mergeRes.merged.length, 1);
    assert.strictEqual(mergeRes.merged[0].message, 'YouTube 地区 [US] 不符合预期 [JP]');
  });

  // Case 4 — DNSBL legacy event kept
  it('Case 4: DNSBL legacy event is kept and triggers notification', () => {
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

    const mergeRes = mergeAlerts('node-dnsbl', [], rawLegacyAlerts);
    const filterRes = filterAlerts(mergeRes.merged, makeConfig());
    assert.strictEqual(filterRes.kept, 1);
    assert.strictEqual(filterRes.alerts[0].message, 'DNS 黑名单拦截数增加 (从 0 增至 3)');
  });

  // Case 5 — min_severity applied consistently to both sources
  it('Case 5: min_severity applies consistently to semantic diff and legacy sources', () => {
    const config = makeConfig({ min_severity: 'WARNING' });
    const alerts = [
      { timestamp: '2026-09-25 04:00:00', level: 'INFO', message: 'Semantic info alert', ipVersion: 'IPv4', raw: 's-i', source: 'archive_diff' },
      { timestamp: '2026-09-25 04:00:01', level: 'WARNING', message: 'Semantic warning alert', ipVersion: 'IPv4', raw: 's-w', source: 'archive_diff' },
      { timestamp: '2026-09-25 04:00:02', level: 'INFO', message: 'Legacy info alert', ipVersion: 'IPv4', raw: 'l-i', source: 'alerts_log' },
      { timestamp: '2026-09-25 04:00:03', level: 'CRITICAL', message: 'Legacy critical alert', ipVersion: 'IPv4', raw: 'l-c', source: 'alerts_log' },
    ];

    const filterRes = filterAlerts(alerts, config);
    assert.strictEqual(filterRes.kept, 2);
    assert.strictEqual(filterRes.below_severity, 2);
    assert.deepStrictEqual(filterRes.alerts.map(a => a.level), ['CRITICAL', 'WARNING']);
    assert.strictEqual(filterRes.alerts[0].message, 'Legacy critical alert');
    assert.strictEqual(filterRes.alerts[1].message, 'Semantic warning alert');
  });

  // Case 6 — sync_archives=false
  it('Case 6: sync_archives=false maintains alerts.log-only behavior without reading daily archive', async () => {
    const node = makeNode({ uuid: 'node-nosync', name: 'Node NoSync' });
    seedDailyReport(node.uuid, {
      changes: [makeSemanticChange({ nodeUuid: node.uuid, description: 'Should not appear when sync_archives=false' })],
    });

    const mockServer = makeMockServer({
      nodes: [node],
      config: { sync_archives: false },
      taskResults: [
        { client_id: node.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n2026-09-25 04:00:00|WARNING|Legacy Only Alert|IPv4' },
      ],
    });

    const results = await collectDailyNodeResults({
      server: mockServer,
      targets: [node],
      config: makeConfig({ sync_archives: false, min_severity: 'INFO' }),
      dateKey: '2026-09-25',
      startEpoch: 1758758400,
      endEpoch: 1758783659,
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].alerts.length, 1);
    assert.strictEqual(results[0].alerts[0].message, 'Legacy Only Alert');
  });

  // Case 7 — Zouter stale does not block DataWave / Vmiss
  it('Case 7: Zouter stale does not block DataWave and Vmiss notifications, not marked as failed', async () => {
    const zouter = makeNode({ uuid: 'zouter-uuid', name: 'Zouter', weight: 1 });
    const datawave = makeNode({ uuid: 'datawave-uuid', name: 'DataWave', weight: 2 });
    const vmiss = makeNode({ uuid: 'vmiss-uuid', name: 'Vmiss', weight: 3 });
    const dateKey = '2026-09-25';

    seedDailyReport(datawave.uuid, {
      date: dateKey,
      changes: [makeSemanticChange({ nodeUuid: datawave.uuid, severity: 'CRITICAL', description: 'DataWave CRITICAL change' })],
    });
    seedDailyReport(vmiss.uuid, {
      date: dateKey,
      changes: [makeSemanticChange({ nodeUuid: vmiss.uuid, severity: 'WARNING', description: 'Vmiss WARNING change' })],
    });
    // Zouter only has yesterday report
    seedDailyReport(zouter.uuid, { date: '2026-09-24', changes: [] });

    let sentMessage = '';
    let notificationSent = false;
    const mockServer = makeMockServer({
      nodes: [zouter, datawave, vmiss],
      taskResults: [
        { client_id: zouter.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' },
        { client_id: datawave.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' },
        { client_id: vmiss.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' },
      ],
      onNotification: (params) => {
        notificationSent = true;
        sentMessage = params?.event?.message || params?.message || '';
      },
    });

    await runDailyReport(mockServer, new Date('2026-09-24T23:00:00Z'));
    assert.strictEqual(notificationSent, true, 'Notification must be sent for DataWave and Vmiss');
    assert.ok(sentMessage.includes('DataWave'));
    assert.ok(sentMessage.includes('Vmiss'));
    assert.ok(!sentMessage.includes('❌ 采集异常'), 'Zouter must not be listed as collection failure');
  });

  // Case 8 — pending_today at 04:30 BJT
  it('Case 8: pending_today at 04:30 BJT when latest archive is yesterday', () => {
    const time0430 = new Date('2026-09-24T20:30:00Z');
    assert.strictEqual(determineNoUpdateStatus('2026-09-24', time0430), 'pending_today');
  });

  // Case 9 — stale boundary at 05:01 BJT
  it('Case 9: stale at 05:01 BJT when latest archive is yesterday', () => {
    const time0501 = new Date('2026-09-24T21:01:00Z');
    assert.strictEqual(determineNoUpdateStatus('2026-09-24', time0501), 'stale');
  });

  // Case 10 — current date archive
  it('Case 10: current / already_current when latest archive is today at 05:01 BJT', () => {
    const time0501 = new Date('2026-09-24T21:01:00Z');
    assert.strictEqual(determineNoUpdateStatus('2026-09-25', time0501), 'already_current');
  });

  // Case 11 — no archive
  it('Case 11: no_archive status when node has no archive records', () => {
    const time0501 = new Date('2026-09-24T21:01:00Z');
    assert.strictEqual(determineNoUpdateStatus(null, time0501), 'no_archive');
  });

  // Case 12 — 07:00 calling sequence
  it('Case 12: 07:00 calling sequence strictly matches pre-report sync -> local read & remote alerts -> notification', async () => {
    const sequence = [];
    const node = makeNode({ uuid: 'node-seq', name: 'Node Seq' });
    seedDailyReport(node.uuid, {
      changes: [makeSemanticChange({ nodeUuid: node.uuid, description: 'Sequence test change' })],
    });

    const mockServer = makeMockServer({
      nodes: [node],
      execCallback: (params) => {
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
      },
      taskResults: (params) => {
        const tid = params?.task_id || params?.taskId;
        if (tid === 'task-sync') {
          return [{ client_id: node.uuid, status: 'completed', stdout: '__IPQA_MANIFEST_BEGIN__\n__IPQA_MANIFEST_END__' }];
        }
        return [{ client_id: node.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' }];
      },
      onNotification: () => {
        sequence.push('send_notification');
      },
    });

    await runDailyReport(mockServer, new Date('2026-09-24T23:00:00Z'));
    assert.deepStrictEqual(sequence, ['pre_report_sync', 'alerts_collection', 'send_notification']);
  });

  // Case 13 — same day only executes once
  it('Case 13: same Beijing date execution happens at most once', async () => {
    const mockServer = makeMockServer({ nodes: [] });
    const at0700 = new Date('2026-09-24T23:00:00Z');
    await runDailyReport(mockServer, at0700);

    const state = loadState();
    assert.strictEqual(state.last_run_beijing_date, '2026-09-25');

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
    const node = makeNode({ uuid: 'node-err', name: 'Node Err' });
    seedDailyReport(node.uuid, {
      changes: [makeSemanticChange({ nodeUuid: node.uuid, description: 'Error test change' })],
    });

    const mockServer = makeMockServer({
      nodes: [node],
      taskResults: [{ client_id: node.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' }],
      onNotification: () => {
        throw new Error('Telegram network error');
      },
    });

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
    const node = makeNode({ uuid: 'node-parity', name: 'Node Parity' });
    seedDailyReport(node.uuid, {
      changes: [makeSemanticChange({ nodeUuid: node.uuid, description: 'Parity score change' })],
    });

    const mockServer = makeMockServer({
      nodes: [node],
      taskResults: [
        { client_id: node.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n2026-09-25 04:00:00|WARNING|Supplemental Event|IPv4' },
      ],
    });

    const runTime = new Date('2026-09-24T23:00:00Z');
    const testResult = await runTestReport(mockServer, { window: 'today_0700' }, runTime);
    await runDailyReport(mockServer, runTime);
    const state = loadState();

    assert.strictEqual(testResult.alertCount, 2, 'Manual test should see 2 alerts');
    assert.strictEqual(state.last_summary?.alerts, 2, 'Scheduled report should see identical 2 alerts');
    assert.strictEqual(testResult.criticalCount, 1);
    assert.strictEqual(testResult.warningCount, 1);
  });

  // Case 16 — raw=1 filtered=0 explainable
  it('Case 16: raw=1 filtered=0 log counts are transparent and explainable', () => {
    const rawLegacyAlerts = [
      { timestamp: '2026-09-25 04:00:00', level: 'INFO', message: 'Low severity notice', ipVersion: 'IPv4', raw: '2026-09-25 04:00:00|INFO|Low severity notice|IPv4', source: 'alerts_log' },
    ];

    const mergeRes = mergeAlerts('node-explain', [], rawLegacyAlerts);
    const filterRes = filterAlerts(mergeRes.merged, makeConfig({ min_severity: 'WARNING' }));
    assert.strictEqual(mergeRes.legacyRawCount, 1);
    assert.strictEqual(filterRes.kept, 0);
    assert.strictEqual(filterRes.below_severity, 1);
  });

  // ---------------------------------------------------------------------------
  // Section 11: Cleanup & Correctness New Regression Cases (Cases 17–21)
  // ---------------------------------------------------------------------------

  // Case 17 — semantic survives legacy NOT_FOUND
  it('Case 17: semantic survives legacy NOT_FOUND -> alertCount=1, status=OK', async () => {
    const node = makeNode({ uuid: 'node-c17', name: 'Node C17' });
    const dateKey = '2026-09-25';
    seedDailyReport(node.uuid, {
      date: dateKey,
      changes: [makeSemanticChange({ nodeUuid: node.uuid, severity: 'WARNING', description: 'Semantic survives NOT_FOUND' })],
    });

    let sentMsg = '';
    let notificationSent = false;
    const server = makeMockServer({
      nodes: [node],
      taskResults: [
        { client_id: node.uuid, status: 'completed', stdout: '__IPQA_STATUS__|NOT_FOUND\n' },
      ],
      onNotification: (p) => {
        notificationSent = true;
        sentMsg = p?.event?.message || p?.message || '';
      },
    });

    await runDailyReport(server, new Date('2026-09-24T23:00:00Z'));
    assert.strictEqual(notificationSent, true, 'Notification should be sent despite legacy NOT_FOUND');
    assert.ok(sentMsg.includes('Node C17'));
    assert.ok(sentMsg.includes('Semantic survives NOT_FOUND'));
  });

  // Case 18 — semantic survives legacy TIMEOUT
  it('Case 18: semantic survives legacy TIMEOUT -> alertCount=1, status=OK', async () => {
    const node = makeNode({ uuid: 'node-c18', name: 'Node C18' });
    const dateKey = '2026-09-25';
    seedDailyReport(node.uuid, {
      date: dateKey,
      changes: [makeSemanticChange({ nodeUuid: node.uuid, severity: 'CRITICAL', description: 'Semantic survives TIMEOUT' })],
    });

    let sentMsg = '';
    let notificationSent = false;
    const server = makeMockServer({
      nodes: [node],
      taskResults: [
        { client_id: node.uuid, status: 'TIMEOUT', error: 'Agent task timeout' },
      ],
      onNotification: (p) => {
        notificationSent = true;
        sentMsg = p?.event?.message || p?.message || '';
      },
    });

    await runDailyReport(server, new Date('2026-09-24T23:00:00Z'));
    assert.strictEqual(notificationSent, true, 'Notification should be sent despite legacy TIMEOUT');
    assert.ok(sentMsg.includes('Node C18'));
    assert.ok(sentMsg.includes('Semantic survives TIMEOUT'));
  });

  // Case 19 — no semantic + legacy failure
  it('Case 19: no semantic + legacy timeout -> failedNodes=1', async () => {
    const node = makeNode({ uuid: 'node-c19', name: 'Node C19' });
    let notificationSent = false;
    let sentMsg = '';
    const server = makeMockServer({
      nodes: [node],
      config: { notify_collection_failures: true },
      taskResults: [
        { client_id: node.uuid, status: 'TIMEOUT', error: 'Task timeout after 30s' },
      ],
      onNotification: (p) => {
        notificationSent = true;
        sentMsg = p?.event?.message || p?.message || '';
      },
    });

    await runDailyReport(server, new Date('2026-09-24T23:00:00Z'));
    const state = loadState();
    assert.strictEqual(state.last_summary?.collection_failures, 1, 'Node must be recorded as collection failure');
    assert.strictEqual(notificationSent, true, 'Failure notification must be sent');
    assert.ok(sentMsg.includes('❌ 采集异常'));
    assert.ok(sentMsg.includes('Node C19'));
  });

  // Case 20 — type dedupe precision
  it('Case 20: semantic info.type does not suppress legacy company type', () => {
    const nodeUuid = 'node-type-precision';
    const semanticAlerts = [
      {
        timestamp: '2026-09-25T04:00:00Z',
        level: 'CRITICAL',
        message: 'IP 类型变更为: [原生IP] (原: [广播IP])',
        ipVersion: 'IPv4',
        raw: 'sem-info-type',
        source: 'archive_diff',
        dedupeKey: `${nodeUuid}|IPv4|type|info.type|广播IP|原生IP`,
      },
    ];

    const rawLegacyAlerts = [
      {
        timestamp: '2026-09-25 04:05:00',
        level: 'WARNING',
        message: 'IP2Location 公司类型属性变更为: [ISP/MOB] (原: [DCH])',
        ipVersion: 'IPv4',
        raw: '2026-09-25 04:05:00|WARNING|IP2Location 公司类型属性变更为: [ISP/MOB] (原: [DCH])|IPv4',
        source: 'alerts_log',
      },
    ];

    const mergeRes = mergeAlerts(nodeUuid, semanticAlerts, rawLegacyAlerts);
    assert.strictEqual(mergeRes.merged.length, 2, 'Both semantic info.type and legacy company type must be preserved');
    assert.strictEqual(mergeRes.deduplicatedCount, 0, 'No false deduplication');
  });

  // Case 21 — last_24h boundary
  it('Case 21: last_24h window excludes yesterday semantic changes older than 24h', async () => {
    const node = makeNode({ uuid: 'node-c21', name: 'Node C21' });
    const testNow = new Date('2026-09-25T12:00:00Z'); // 20:00 BJT

    // 1. Yesterday archive generated at 04:00 BJT (older than 24h -> outside window!)
    seedDailyReport(node.uuid, {
      date: '2026-09-24',
      timestamp: '2026-09-24T04:00:00Z',
      changes: [
        makeSemanticChange({
          nodeUuid: node.uuid,
          date: '2026-09-24',
          description: 'Yesterday 04:00 change (should be excluded)',
        }),
      ],
    });

    // 2. Today archive generated at 04:00 BJT (inside window [2026-09-24 20:00, 2026-09-25 20:00])
    seedDailyReport(node.uuid, {
      date: '2026-09-25',
      timestamp: '2026-09-25T04:00:00Z',
      changes: [
        makeSemanticChange({
          nodeUuid: node.uuid,
          date: '2026-09-25',
          description: 'Today 04:00 change (should be included)',
        }),
      ],
    });

    const server = makeMockServer({
      nodes: [node],
      taskResults: [
        { client_id: node.uuid, status: 'completed', stdout: '__IPQA_STATUS__|OK\n' },
      ],
    });

    const result = await runTestReport(server, { window: 'last_24h' }, testNow);
    assert.strictEqual(result.alertCount, 1, 'Only today 04:00 change should be included in last_24h');
    assert.strictEqual(result.report?.alertNodes[0].alerts[0].message, 'Today 04:00 change (should be included)');
  });
});
