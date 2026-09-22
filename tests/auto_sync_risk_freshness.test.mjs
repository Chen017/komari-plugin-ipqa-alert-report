import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyScore, classifyScores, compareScoreTransition, getHighestRisk, isNullLike } from '../src/ipqa/risk.ts';
import { calculateFreshness } from '../src/ipqa/freshness.ts';
import { normalizeRawIpqa, toBeijingDateString } from '../src/ipqa/archive-normalize.ts';
import { pairDailyReports } from '../src/ipqa/archive-pair.ts';
import { compareDailyReports } from '../src/ipqa/archive-diff.ts';
import {
  syncNodeArchives,
  syncIpqaArchives,
  rebuildNodeDailyReports,
  buildNodeOverview,
} from '../src/ipqa/archive-sync.ts';
import {
  saveRawArchive,
  getDailyReport,
  getLatestDailyReport,
  listDailyDates,
  getFleetOverview,
  getNodeDir,
} from '../src/storage/archive-store.ts';

// ---------------------------------------------------------------------------
// Section 33: Risk fixture (DataWave ipapi 2.73% -> 18.16%)
// ---------------------------------------------------------------------------
test('Section 33: DataWave risk transition fixture (2.73% -> 18.16%)', () => {
  const scoreBefore = classifyScore('ipapi', '2.73%');
  assert.strictEqual(scoreBefore.category, 'Medium');
  assert.strictEqual(scoreBefore.badge, '较高风险');
  assert.strictEqual(scoreBefore.rank, 2);

  const scoreAfter = classifyScore('ipapi', '18.16%');
  assert.strictEqual(scoreAfter.category, 'Critical');
  assert.strictEqual(scoreAfter.badge, '极高风险');
  assert.strictEqual(scoreAfter.rank, 4);

  // Highest risk on report
  const highest = getHighestRisk({ ipapi: '18.16%', IP2LOCATION: '3', SCAMALYTICS: '15' });
  assert.strictEqual(highest.category, 'Critical');
  assert.strictEqual(highest.source, 'ipapi');
  assert.strictEqual(highest.badge, '极高风险');

  // Semantic transition diff
  const transition = compareScoreTransition('ipapi', '2.73%', '18.16%');
  assert.strictEqual(transition.severity, 'CRITICAL');
  assert.ok(transition.description.includes('严重') || transition.description.includes('极高风险'));
  assert.ok(transition.description.includes('较高风险'));
});

// ---------------------------------------------------------------------------
// Section 34: Null-like score values produce Unknown / -1, never Low
// ---------------------------------------------------------------------------
test('Section 34: Null-like scores never default to Low', () => {
  const nullValues = [null, undefined, 'null', '', 'N/A', '--', '-'];
  for (const v of nullValues) {
    const res = classifyScore('IPQS', v);
    assert.strictEqual(res.category, 'Unknown', `Value ${v} should be Unknown`);
    assert.strictEqual(res.rank, -1);
    assert.strictEqual(res.badge, '无数据');
  }

  const highestAllNull = getHighestRisk({ IPQS: 'null', DBIP: null, scamalytics: '' });
  assert.strictEqual(highestAllNull.category, 'Unknown');
  assert.strictEqual(highestAllNull.source, 'None');
  assert.strictEqual(highestAllNull.badge, '无数据');
  assert.strictEqual(highestAllNull.rank, -1);

  // When mixed with a Low score, highest is Low (from that score, not from null)
  const highestMixed = getHighestRisk({ IPQS: 'null', scamalytics: '5' });
  assert.strictEqual(highestMixed.category, 'Low');
  assert.strictEqual(highestMixed.source, 'scamalytics');
});

// ---------------------------------------------------------------------------
// Section 35: Freshness boundary tests
// ---------------------------------------------------------------------------
test('Section 35: Freshness boundary tests', () => {
  const yesterday = '2026-09-21';
  const today = '2026-09-22';

  // 1. 03:30 BJT: latest = yesterday -> fresh (today has not run yet)
  const time0330 = new Date('2026-09-21T19:30:00Z'); // 03:30 BJT next day (09-22)
  const fresh0330 = calculateFreshness({ now: time0330, latestDate: yesterday });
  assert.strictEqual(fresh0330.status, 'fresh');
  assert.strictEqual(fresh0330.expectedDate, today);

  // 2. 04:30 BJT: latest = yesterday -> pending_today (inside 04:00-05:00 grace)
  const time0430 = new Date('2026-09-21T20:30:00Z'); // 04:30 BJT
  const fresh0430 = calculateFreshness({ now: time0430, latestDate: yesterday });
  assert.strictEqual(fresh0430.status, 'pending_today');
  assert.strictEqual(fresh0430.expectedDate, today);

  // 3. 05:01 BJT: latest = yesterday -> stale (grace passed, today missing)
  const time0501 = new Date('2026-09-21T21:01:00Z'); // 05:01 BJT
  const fresh0501 = calculateFreshness({ now: time0501, latestDate: yesterday });
  assert.strictEqual(fresh0501.status, 'stale');
  assert.strictEqual(fresh0501.expectedDate, today);

  // 4. 07:30 BJT: latest = today -> fresh
  const time0730 = new Date('2026-09-21T23:30:00Z'); // 07:30 BJT
  const fresh0730 = calculateFreshness({ now: time0730, latestDate: today });
  assert.strictEqual(fresh0730.status, 'fresh');
  assert.strictEqual(fresh0730.expectedDate, today);
});

// ---------------------------------------------------------------------------
// Section 36: Less than 36h can still be stale
// ---------------------------------------------------------------------------
test('Section 36: Missing today report is stale even if age < 36h', () => {
  // At 09-22 06:00 BJT, yesterday 09-21 04:00 BJT is only 26 hours old (< 36h)
  const now0600 = new Date('2026-09-21T22:00:00Z'); // 06:00 BJT on 09-22
  const res = calculateFreshness({ now: now0600, latestDate: '2026-09-21' });
  assert.strictEqual(res.status, 'stale', 'Should be stale because today 09-22 is past grace and missing');
});

// ---------------------------------------------------------------------------
// Section 37: Multiple VPS timezones normalized to same Beijing logical date
// ---------------------------------------------------------------------------
test('Section 37: Multiple VPS timezones normalize to same Beijing logical date', () => {
  // Absolute UTC time: 2026-09-21T20:00:01Z -> Beijing Time: 2026-09-22 04:00:01
  const utcDate = new Date('2026-09-21T20:00:01Z');
  const beijingDateStr = toBeijingDateString(utcDate);
  assert.strictEqual(beijingDateStr, '2026-09-22');

  const rawSample = { Info: { IP: '1.1.1.1' }, Score: { ipapi: '2.5%' } };
  const normalized = normalizeRawIpqa(rawSample, 'v4', '2026-09-21_200001.json');
  assert.strictEqual(normalized.date, '2026-09-22', 'Filename timestamp in UTC must normalize to Beijing date');
});

// ---------------------------------------------------------------------------
// Section 32: Same-day duplicate replaces canonical daily report
// ---------------------------------------------------------------------------
test('Section 32: Same-day later archive replaces canonical daily report', () => {
  const nodeUuid = 'test-node-dup';
  const report1 = normalizeRawIpqa(
    { Info: { IP: '1.1.1.1' }, Score: { ipapi: '2.0%' } },
    'v4',
    '2026-09-22_040001.json'
  );
  const report2 = normalizeRawIpqa(
    { Info: { IP: '1.1.1.1' }, Score: { ipapi: '15.0%' } }, // later scan on same day
    'v4',
    '2026-09-22_120000.json'
  );

  const paired = pairDailyReports([report1, report2], [], nodeUuid);
  assert.strictEqual(paired.length, 1);
  assert.strictEqual(paired[0].date, '2026-09-22');
  assert.strictEqual(paired[0].v4?.scores.ipapi, '15.0%', 'Later archive must replace earlier one');
  assert.strictEqual(paired[0].summary.highestRiskCategory, 'Critical');
});

// ---------------------------------------------------------------------------
// Section 29, 30, 31, 38: End-to-end sync, retry, consistency
// ---------------------------------------------------------------------------
test('Section 29, 30, 31, 38: Mock server archive sync and API consistency', async () => {
  const nodeUuid = 'mock-node-1';
  const mockNode = { uuid: nodeUuid, name: 'DataWave', weight: 1 };

  // Set up mock server
  let mockManifestOutput = `
__IPQA_MANIFEST_BEGIN__
__IPQA_ENTRY__|v4|2026-09-21_200001.json|500|1789992001
__IPQA_MANIFEST_END__
`;

  const rawJson20260922 = {
    Info: { IP: '198.51.100.1', Country: 'United States', Region: 'CA' },
    Score: { ipapi: '18.16%', IP2LOCATION: '3', SCAMALYTICS: '15' },
    Media: { YouTube: { Status: '已解锁', Region: 'US' } },
  };

  const b64 = Buffer.from(JSON.stringify(rawJson20260922)).toString('base64');
  const mockBatchFetchOutput = `
__IPQA_BATCH_BEGIN__
__IPQA_FILE_BEGIN__|v4|2026-09-21_200001.json
${b64}
__IPQA_FILE_END__
__IPQA_BATCH_END__
`;

  const mockServer = {
    cron: () => {},
    call: async (method, params) => {
      if (method === 'common:getNodes') return [mockNode];
      if (method === 'admin:exec') {
        const cmd = params?.command || '';
        if (cmd.includes('__IPQA_MANIFEST_BEGIN__')) {
          return { task_id: 't-manifest' };
        }
        if (cmd.includes('__IPQA_BATCH_BEGIN__')) {
          return { task_id: 't-fetch' };
        }
        return { task_id: 't-unknown' };
      }
      if (method === 'admin:getTaskResultsByTaskId') {
        const tid = params?.task_id || params?.taskId;
        if (tid === 't-manifest') {
          return {
            results: [{ client: nodeUuid, exit_code: 0, stdout: mockManifestOutput }],
          };
        }
        if (tid === 't-fetch') {
          return {
            results: [{ client: nodeUuid, exit_code: 0, stdout: mockBatchFetchOutput }],
          };
        }
      }
      return {};
    },
    getConfig: () => ({ enabled: true, sync_archives: true, all_nodes: true }),
  };

  // Run sync
  const now = new Date('2026-09-21T22:00:00Z'); // 06:00 BJT on 2026-09-22
  const syncResult = await syncIpqaArchives(mockServer, { reason: 'daily', now });

  assert.strictEqual(syncResult.reason, 'daily');
  assert.strictEqual(syncResult.nodes.length, 1);
  assert.strictEqual(syncResult.nodes[0].latestDate, '2026-09-22');

  // Assert API consistency across all data stores (Section 38)
  const latestReport = getLatestDailyReport(nodeUuid);
  assert.ok(latestReport, 'Latest report must exist');
  assert.strictEqual(latestReport.date, '2026-09-22');
  assert.strictEqual(latestReport.summary.highestRiskCategory, 'Critical');
  assert.strictEqual(latestReport.summary.highestRiskSource, 'ipapi');

  const dailyDates = listDailyDates(nodeUuid);
  assert.strictEqual(dailyDates[0], '2026-09-22');

  const overview = getFleetOverview();
  assert.ok(overview, 'Fleet overview must exist');
  assert.strictEqual(overview.latest_archive_date, '2026-09-22');
  const nodeOverview = overview.nodes.find(n => n.uuid === nodeUuid);
  assert.ok(nodeOverview);
  assert.strictEqual(nodeOverview.latest_date, '2026-09-22');
  assert.strictEqual(nodeOverview.highest_risk.category, 'Critical');
  assert.strictEqual(nodeOverview.highest_risk.source, 'ipapi');
  assert.strictEqual(nodeOverview.freshness?.status, 'fresh');
  assert.strictEqual(nodeOverview.freshness?.latestDate, '2026-09-22');

  // Retry test (Section 30): running sync again when already current skips remote execution
  const secondSync = await syncIpqaArchives(mockServer, { reason: 'daily', now });
  assert.strictEqual(secondSync.nodes[0].status, 'already_current');

  // Verify classifiedScores and semantic transitions
  const normalized = normalizeRawIpqa({
    scores: { ipapi: '18.16%', IP2LOCATION: '3', IPQS: 'null' },
  }, 'v4', '2026-09-22_040000.json');
  assert.ok(normalized.classifiedScores);
  assert.strictEqual(normalized.classifiedScores.ipapi.categoryKey, 'Critical');
  assert.strictEqual(normalized.classifiedScores.ipapi.categoryLabel, '极高风险');
  assert.strictEqual(normalized.classifiedScores.ipapi.rank, 4);
  assert.strictEqual(normalized.classifiedScores.ipapi.alertSeverity, 'CRITICAL');
  assert.strictEqual(normalized.classifiedScores.IPQS.available, false);
  assert.strictEqual(normalized.classifiedScores.IPQS.categoryKey, 'Unknown');

  // Semantic diff transition fields
  const diffs = compareDailyReports(
    {
      schemaVersion: 1,
      nodeUuid: 'test-node',
      date: '2026-09-21',
      updatedAt: '',
      v4: normalizeRawIpqa({ scores: { ipapi: '2.73%' } }, 'v4', '2026-09-21_040000.json'),
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Medium', highestRiskSource: 'ipapi', mediaSummary: {}, aiSummary: {} },
    },
    {
      schemaVersion: 1,
      nodeUuid: 'test-node',
      date: '2026-09-22',
      updatedAt: '',
      v4: normalized,
      v6: null,
      summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Critical', highestRiskSource: 'ipapi', mediaSummary: {}, aiSummary: {} },
    }
  );
  const ipapiDiff = diffs.find(d => d.field === 'scores.ipapi');
  assert.ok(ipapiDiff);
  assert.strictEqual(ipapiDiff.beforeCategory, '较高风险');
  assert.strictEqual(ipapiDiff.afterCategory, '极高风险');
  assert.strictEqual(ipapiDiff.severity, 'CRITICAL');
});
