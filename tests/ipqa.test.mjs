import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAlertLine,
  parseNodeResult,
  getSeverityRank,
} from '../src/ipqa.ts';

describe('ipqa.ts - IPQA Protocol & Alert Parsing', () => {
  const dummyNode = {
    uuid: 'node-la',
    name: 'Los Angeles',
    weight: 10,
  };

  const baseConfig = {
    enabled: true,
    all_nodes: false,
    nodes: ['node-la'],
    min_severity: 'INFO',
    ignore_initial_archive: true,
    notify_collection_failures: true,
    template: '',
  };

  it('should parse valid alert line with pipe delimiter in message', () => {
    const line =
      '2026-09-21 04:10:02|WARNING|Netflix 地区发生变化: [US] -> [JP] | 测试|IPv4';
    const parsed = parseAlertLine(line);
    assert.ok(parsed);
    assert.equal(parsed.timestamp, '2026-09-21 04:10:02');
    assert.equal(parsed.level, 'WARNING');
    assert.equal(
      parsed.message,
      'Netflix 地区发生变化: [US] -> [JP] | 测试'
    );
    assert.equal(parsed.ipVersion, 'IPv4');
  });

  it('should handle protocol status headers correctly', () => {
    // 1. OK
    const okRes = parseNodeResult(
      dummyNode,
      { stdout: '__IPQA_STATUS__|OK\n2026-09-21 04:10:02|WARNING|Netflix changed|IPv4' },
      baseConfig
    );
    assert.equal(okRes.status, 'OK');
    assert.equal(okRes.alerts.length, 1);

    // 2. NOT_FOUND
    const notFoundRes = parseNodeResult(
      dummyNode,
      { stdout: '__IPQA_STATUS__|NOT_FOUND' },
      baseConfig
    );
    assert.equal(notFoundRes.status, 'NOT_FOUND');
    assert.equal(notFoundRes.alerts.length, 0);
    assert.ok(notFoundRes.error?.includes('alerts.log not found'));

    // 3. DATE_CONVERSION_FAILED
    const dateFailRes = parseNodeResult(
      dummyNode,
      { stdout: '__IPQA_STATUS__|DATE_CONVERSION_FAILED' },
      baseConfig
    );
    assert.equal(dateFailRes.status, 'DATE_CONVERSION_FAILED');

    // 4. TIMEOUT
    const timeoutRes = parseNodeResult(
      dummyNode,
      { status: 'TIMEOUT', error: 'Agent task timeout after 30s' },
      baseConfig
    );
    assert.equal(timeoutRes.status, 'TIMEOUT');
  });

  it('should filter out initial archive record when ignore_initial_archive=true', () => {
    const stdout = `__IPQA_STATUS__|OK
2026-09-21 04:00:00|INFO|首次完成数据存档监测|IPv4
2026-09-21 04:05:00|CRITICAL|IPQS 风险升高|IPv4`;

    const res = parseNodeResult(dummyNode, { stdout }, baseConfig);
    assert.equal(res.status, 'OK');
    assert.equal(res.alerts.length, 1);
    assert.equal(res.alerts[0].level, 'CRITICAL');
  });

  it('should filter by min_severity', () => {
    const stdout = `__IPQA_STATUS__|OK
2026-09-21 04:01:00|INFO|Info alert 1|IPv4
2026-09-21 04:02:00|INFO|Info alert 2|IPv6
2026-09-21 04:03:00|WARNING|Warning alert 1|IPv4
2026-09-21 04:04:00|CRITICAL|Critical alert 1|IPv4`;

    // 1. With min_severity = INFO -> 4 alerts
    const resInfo = parseNodeResult(
      dummyNode,
      { stdout },
      { ...baseConfig, min_severity: 'INFO' }
    );
    assert.equal(resInfo.alerts.length, 4);

    // 2. With min_severity = WARNING -> 2 alerts (WARNING + CRITICAL)
    const resWarn = parseNodeResult(
      dummyNode,
      { stdout },
      { ...baseConfig, min_severity: 'WARNING' }
    );
    assert.equal(resWarn.alerts.length, 2);
    assert.equal(resWarn.alerts[0].level, 'CRITICAL');
    assert.equal(resWarn.alerts[1].level, 'WARNING');

    // 3. With min_severity = CRITICAL -> 1 alert (CRITICAL only)
    const resCrit = parseNodeResult(
      dummyNode,
      { stdout },
      { ...baseConfig, min_severity: 'CRITICAL' }
    );
    assert.equal(resCrit.alerts.length, 1);
    assert.equal(resCrit.alerts[0].level, 'CRITICAL');
  });

  it('should deduplicate identical raw lines within the same node', () => {
    const stdout = `__IPQA_STATUS__|OK
2026-09-21 04:10:02|WARNING|Duplicate test|IPv4
2026-09-21 04:10:02|WARNING|Duplicate test|IPv4
2026-09-21 04:15:00|WARNING|Different test|IPv4`;

    const res = parseNodeResult(dummyNode, { stdout }, baseConfig);
    assert.equal(res.alerts.length, 2);
    assert.equal(res.alerts[0].message, 'Duplicate test');
    assert.equal(res.alerts[1].message, 'Different test');
  });
});
