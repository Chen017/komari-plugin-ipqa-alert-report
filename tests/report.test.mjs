import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyReport,
  shouldSendNotification,
  renderReport,
  applyTemplate,
  MAX_REPORT_LENGTH,
} from '../src/report.ts';

describe('report.ts - Daily Report Aggregation & Rendering', () => {
  const baseConfig = {
    enabled: true,
    all_nodes: false,
    nodes: ['node-1', 'node-2', 'node-3'],
    min_severity: 'INFO',
    ignore_initial_archive: true,
    notify_collection_failures: true,
    template: '',
  };

  it('Test 1: Three nodes with 0 alerts -> shouldSendNotification returns false (Silent)', () => {
    const nodeResults = [
      { uuid: 'node-1', name: 'LA', weight: 1, status: 'OK', alerts: [] },
      { uuid: 'node-2', name: 'Tokyo', weight: 2, status: 'OK', alerts: [] },
      { uuid: 'node-3', name: 'Germany', weight: 3, status: 'OK', alerts: [] },
    ];

    const report = buildDailyReport({
      dateKey: '2026-09-21',
      windowStart: '2026-09-21 00:00:00',
      windowEnd: '2026-09-21 07:00:59',
      selectedNodeCount: 3,
      nodeResults,
    });

    assert.equal(report.alertCount, 0);
    assert.equal(report.alertNodeCount, 0);
    assert.equal(report.failedNodes.length, 0);

    const shouldNotify = shouldSendNotification(report, baseConfig);
    assert.equal(shouldNotify, false, 'Must remain completely silent when no alerts');
  });

  it('Test 2: Single node with alerts -> displays only the alerting node', () => {
    const nodeResults = [
      {
        uuid: 'node-1',
        name: 'Los Angeles',
        weight: 1,
        status: 'OK',
        alerts: [
          {
            timestamp: '2026-09-21 04:10:02',
            level: 'WARNING',
            message: 'Netflix region changed',
            ipVersion: 'IPv4',
            raw: '...',
          },
        ],
      },
      { uuid: 'node-2', name: 'Tokyo', weight: 2, status: 'OK', alerts: [] },
      { uuid: 'node-3', name: 'Germany', weight: 3, status: 'OK', alerts: [] },
    ];

    const report = buildDailyReport({
      dateKey: '2026-09-21',
      windowStart: '2026-09-21 00:00:00',
      windowEnd: '2026-09-21 07:00:59',
      selectedNodeCount: 3,
      nodeResults,
    });

    assert.equal(shouldSendNotification(report, baseConfig), true);
    const rendered = renderReport(report, baseConfig);

    assert.ok(rendered.includes('Los Angeles'));
    assert.ok(rendered.includes('Netflix region changed'));
    assert.ok(!rendered.includes('Tokyo'), 'Non-alerting node Tokyo must not appear');
    assert.ok(!rendered.includes('Germany'), 'Non-alerting node Germany must not appear');
  });

  it('Test 3: Multiple nodes with alerts -> merged into a single report', () => {
    const nodeResults = [
      {
        uuid: 'node-1',
        name: 'Los Angeles',
        weight: 1,
        status: 'OK',
        alerts: [
          {
            timestamp: '2026-09-21 04:11:00',
            level: 'CRITICAL',
            message: 'Risk score high',
            ipVersion: 'IPv4',
            raw: '...',
          },
          {
            timestamp: '2026-09-21 04:12:00',
            level: 'WARNING',
            message: 'Netflix changed',
            ipVersion: 'IPv4',
            raw: '...',
          },
        ],
      },
      {
        uuid: 'node-2',
        name: 'Tokyo',
        weight: 2,
        status: 'OK',
        alerts: [
          {
            timestamp: '2026-09-21 04:08:00',
            level: 'INFO',
            message: 'AbuseIPDB score restored',
            ipVersion: 'IPv6',
            raw: '...',
          },
        ],
      },
      { uuid: 'node-3', name: 'Germany', weight: 3, status: 'OK', alerts: [] },
    ];

    const report = buildDailyReport({
      dateKey: '2026-09-21',
      windowStart: '2026-09-21 00:00:00',
      windowEnd: '2026-09-21 07:00:59',
      selectedNodeCount: 3,
      nodeResults,
    });

    assert.equal(report.alertCount, 3);
    assert.equal(report.criticalCount, 1);
    assert.equal(report.warningCount, 1);
    assert.equal(report.infoCount, 1);

    const rendered = renderReport(report, baseConfig);

    assert.ok(rendered.includes('Los Angeles'));
    assert.ok(rendered.includes('Tokyo'));
    assert.ok(!rendered.includes('Germany'));
    assert.ok(rendered.includes('🔴 1  🟠 1  🔵 1'));
  });

  it('Test 8: Node with collection failure -> displayed under collection failures section', () => {
    const nodeResults = [
      {
        uuid: 'node-1',
        name: 'Los Angeles',
        weight: 1,
        status: 'OK',
        alerts: [
          {
            timestamp: '2026-09-21 04:11:00',
            level: 'CRITICAL',
            message: 'Risk score high',
            ipVersion: 'IPv4',
            raw: '...',
          },
        ],
      },
      {
        uuid: 'node-3',
        name: 'Germany',
        weight: 3,
        status: 'TIMEOUT',
        alerts: [],
        error: 'Agent task timeout after 30s',
      },
    ];

    const report = buildDailyReport({
      dateKey: '2026-09-21',
      windowStart: '2026-09-21 00:00:00',
      windowEnd: '2026-09-21 07:00:59',
      selectedNodeCount: 2,
      nodeResults,
    });

    const rendered = renderReport(report, baseConfig);
    assert.ok(rendered.includes('Los Angeles'));
    assert.ok(rendered.includes('❌ 采集异常'));
    assert.ok(rendered.includes('Germany'));
    assert.ok(rendered.includes('Agent task timeout after 30s'));
  });

  it('Test 7: Node with alerts.log NOT_FOUND -> displayed under collection failures section', () => {
    const nodeResults = [
      {
        uuid: 'node-1',
        name: 'Tokyo',
        weight: 1,
        status: 'NOT_FOUND',
        alerts: [],
        error: 'alerts.log not found (~/.ipqa/data/alerts.log)',
      },
    ];

    const report = buildDailyReport({
      dateKey: '2026-09-21',
      windowStart: '2026-09-21 00:00:00',
      windowEnd: '2026-09-21 07:00:59',
      selectedNodeCount: 1,
      nodeResults,
    });

    assert.equal(shouldSendNotification(report, baseConfig), true);
    const rendered = renderReport(report, baseConfig);
    assert.ok(rendered.includes('⚠️ IPQA 采集异常'));
    assert.ok(rendered.includes('❌ 采集异常'));
    assert.ok(rendered.includes('Tokyo'));
    assert.ok(rendered.includes('alerts.log not found'));
  });

  it('Test 13: Super long report (> 3800 chars) -> intelligently truncated and strictly <= 3800 chars', () => {
    const alerts = [];
    for (let i = 0; i < 50; i++) {
      alerts.push({
        timestamp: `2026-09-21 04:${String(i).padStart(2, '0')}:00`,
        level: 'INFO',
        message: `This is a long info alert message number ${i} with extra text describing changes in details...`,
        ipVersion: 'IPv4',
        raw: `raw-${i}`,
      });
    }

    const nodeResults = [
      { uuid: 'node-1', name: 'Node Massive', weight: 1, status: 'OK', alerts },
    ];

    const report = buildDailyReport({
      dateKey: '2026-09-21',
      windowStart: '2026-09-21 00:00:00',
      windowEnd: '2026-09-21 07:00:59',
      selectedNodeCount: 1,
      nodeResults,
    });

    const rendered = renderReport(report, baseConfig);
    assert.ok(
      rendered.length <= MAX_REPORT_LENGTH,
      `Length ${rendered.length} must not exceed ${MAX_REPORT_LENGTH}`
    );
    assert.ok(rendered.includes('INFO 未展开') || rendered.includes('截断'));
  });

  it('Custom template replacement works as expected', () => {
    const template = 'Date: {{date}}, Alerts: {{alert_count}}, Critical: {{critical_count}}';
    const report = {
      beijingDate: '2026-09-21',
      windowStart: '2026-09-21 00:00:00',
      windowEnd: '2026-09-21 07:00:59',
      selectedNodeCount: 1,
      alertNodeCount: 1,
      alertCount: 5,
      criticalCount: 2,
      warningCount: 2,
      infoCount: 1,
      alertNodes: [],
      failedNodes: [],
    };

    const result = applyTemplate(template, report, 'default text');
    assert.equal(result, 'Date: 2026-09-21, Alerts: 5, Critical: 2');
  });
});
