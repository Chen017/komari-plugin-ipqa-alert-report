import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildManifestCommand,
  parseManifestOutput,
  ARCHIVE_FILENAME_REGEX,
} from '../src/ipqa/archive-manifest.ts';
import {
  buildBatchFetchCommand,
  parseBatchFetchOutput,
} from '../src/ipqa/archive-fetch.ts';
import {
  normalizeRawIpqa,
  getReportRiskCategory,
} from '../src/ipqa/archive-normalize.ts';
import { pairDailyReports } from '../src/ipqa/archive-pair.ts';
import { compareDailyReports } from '../src/ipqa/archive-diff.ts';
import { rebuildNodeDailyReports } from '../src/ipqa/archive-sync.ts';
import {
  saveRawArchive,
  getDailyReport,
  saveDailyReport,
  listDailyDates,
  saveFleetOverview,
  getFleetOverview,
} from '../src/storage/archive-store.ts';

test('archive-manifest: filename validation & manifest parsing', () => {
  // 1. Filename regex check
  assert.ok(ARCHIVE_FILENAME_REGEX.test('2026-09-21_040002.json'));
  assert.ok(!ARCHIVE_FILENAME_REGEX.test('alerts.log'));
  assert.ok(!ARCHIVE_FILENAME_REGEX.test('2026-09-21.json'));
  assert.ok(!ARCHIVE_FILENAME_REGEX.test('invalid_name.json'));

  // 2. Command builder
  const cmd = buildManifestCommand();
  assert.ok(cmd.includes('__IPQA_MANIFEST_BEGIN__'));
  assert.ok(cmd.includes('__IPQA_ENTRY__|v4'));
  assert.ok(cmd.includes('__IPQA_ENTRY__|v6'));

  // 3. Manifest parsing
  const mockStdout = `
__IPQA_MANIFEST_BEGIN__
__IPQA_ENTRY__|v4|2026-09-21_040002.json|12345|1789991234
__IPQA_ENTRY__|v4|2026-09-20_040001.json|12000|1789904834
__IPQA_ENTRY__|v6|2026-09-21_040035.json|11500|1789991267
__IPQA_ENTRY__|v4|invalid_file.json|100|1789991234
__IPQA_MANIFEST_END__
`;
  const entries = parseManifestOutput(mockStdout);
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].filename, '2026-09-21_040035.json');
  assert.strictEqual(entries[0].ipVersion, 'v6');
  assert.strictEqual(entries[0].date, '2026-09-21');
  assert.strictEqual(entries[1].filename, '2026-09-21_040002.json');
  assert.strictEqual(entries[1].ipVersion, 'v4');
});

test('archive-fetch: batch framing and base64 parsing', () => {
  const targets = [
    { ipVersion: 'v4', filename: '2026-09-21_040002.json' },
    { ipVersion: 'v6', filename: '2026-09-21_040035.json' },
  ];
  const cmd = buildBatchFetchCommand(targets);
  assert.ok(cmd.includes('__IPQA_FILE_BEGIN__|v4|2026-09-21_040002.json'));
  assert.ok(cmd.includes('base64'));

  const jsonV4 = { Info: { IP: '1.2.3.4', Country: 'Japan' }, Score: { IPQS: 15 } };
  const jsonV6 = { Info: { IP: '2001:db8::1' }, Score: { IPQS: 5 } };

  const b64V4 = Buffer.from(JSON.stringify(jsonV4)).toString('base64');
  const b64V6 = Buffer.from(JSON.stringify(jsonV6)).toString('base64');

  const mockStdout = `
__IPQA_BATCH_BEGIN__
__IPQA_FILE_BEGIN__|v4|2026-09-21_040002.json
${b64V4}
__IPQA_FILE_END__
__IPQA_FILE_BEGIN__|v6|2026-09-21_040035.json
${b64V6}
__IPQA_FILE_END__
__IPQA_BATCH_END__
`;

  const parsed = parseBatchFetchOutput(mockStdout);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].ipVersion, 'v4');
  assert.strictEqual(parsed[0].filename, '2026-09-21_040002.json');
  assert.strictEqual(parsed[0].rawJson.Info.IP, '1.2.3.4');
  assert.strictEqual(parsed[1].ipVersion, 'v6');
  assert.strictEqual(parsed[1].rawJson.Info.IP, '2001:db8::1');
});

test('archive-normalize: normalization and unknown-field preservation', () => {
  const raw = {
    Info: {
      IP: '8.8.8.8',
      Country: 'United States',
      Region: 'California',
      City: 'Mountain View',
      ASN: 15169,
      ISP: 'Google LLC',
      Type: '广播',
    },
    Score: {
      IP2LOCATION: 'Very Low',
      SCAMALYTICS: 0,
      IPQS: 12,
      AbuseIPDB: 0,
    },
    Type: {
      Usage: { IP2LOCATION: 'Data Center/Web Hosting/Transit' },
      Company: { IP2LOCATION: 'Google LLC' },
    },
    Factor: {
      Proxy: { IP2LOCATION: false, ipapi: false },
      VPN: { IP2LOCATION: false, IPQS: false },
    },
    Media: {
      Netflix: { Status: '解锁', Region: '[US]' },
      ChatGPT: { Status: '解锁' },
    },
    Mail: {
      DNSBlacklist: { Blacklisted: 0, Count: 50 },
    },
    // Future unexpected field
    QuantumSecurityCheck: {
      entangled: true,
      qubits: 128,
    },
  };

  const normalized = normalizeRawIpqa(raw, 'v4', '2026-09-21_040002.json');
  assert.strictEqual(normalized.schemaVersion, 1);
  assert.strictEqual(normalized.ipVersion, 'IPv4');
  assert.strictEqual(normalized.date, '2026-09-21');
  assert.strictEqual(normalized.info.ip, '8.8.8.8');
  assert.strictEqual(normalized.info.country, 'United States');
  assert.strictEqual(normalized.scores.IPQS, 12);
  assert.strictEqual(normalized.media.Netflix.region, 'US'); // Cleaned
  assert.strictEqual(normalized.media.ChatGPT.status, '解锁');

  // Unknown field preserved in extra
  assert.ok(normalized.extra.QuantumSecurityCheck);
  assert.strictEqual(normalized.extra.QuantumSecurityCheck.qubits, 128);

  const risk = getReportRiskCategory(normalized);
  assert.strictEqual(risk.category, 'Low');
});

test('archive-pair: daily pairing and duplicate same-date selection', () => {
  const v4Earlier = normalizeRawIpqa(
    { Info: { IP: '1.1.1.1' }, Score: { IPQS: 10 } },
    'v4',
    '2026-09-21_040001.json'
  );
  const v4Later = normalizeRawIpqa(
    { Info: { IP: '1.1.1.2' }, Score: { IPQS: 85 } }, // High risk
    'v4',
    '2026-09-21_120000.json'
  );
  const v6Only = normalizeRawIpqa(
    { Info: { IP: '2001:db8::1' }, Score: { IPQS: 5 } },
    'v6',
    '2026-09-20_040000.json'
  );

  const paired = pairDailyReports([v4Earlier, v4Later], [v6Only], 'test-node-1');
  assert.strictEqual(paired.length, 2);

  // Day 2026-09-21 should pick the later v4 (IP: 1.1.1.2, IPQS: 80 -> High)
  const day21 = paired.find(p => p.date === '2026-09-21');
  assert.ok(day21);
  assert.strictEqual(day21.v4?.info.ip, '1.1.1.2');
  assert.strictEqual(day21.v6, null); // IPv4-only date
  assert.strictEqual(day21.summary.hasV4, true);
  assert.strictEqual(day21.summary.hasV6, false);
  assert.strictEqual(day21.summary.highestRiskCategory, 'High');

  // Day 2026-09-20 is IPv6-only date
  const day20 = paired.find(p => p.date === '2026-09-20');
  assert.ok(day20);
  assert.strictEqual(day20.v4, null);
  assert.strictEqual(day20.v6?.info.ip, '2001:db8::1');
  assert.strictEqual(day20.summary.hasV4, false);
  assert.strictEqual(day20.summary.hasV6, true);
});

test('archive-diff: semantic and generic leaf diff', () => {
  const day1Report = {
    schemaVersion: 1,
    nodeUuid: 'test-node-1',
    date: '2026-09-20',
    updatedAt: '',
    v4: normalizeRawIpqa(
      {
        Info: { IP: '1.2.3.4', Country: 'Japan', Type: '原生' },
        Score: { IPQS: 10 },
        Factor: { Proxy: { IPQS: false } },
        Media: { Netflix: { Status: '解锁', Region: 'JP' } },
        extra: { customMeta: 'alpha' },
      },
      'v4',
      '2026-09-20_040000.json'
    ),
    v6: null,
    summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Low', highestRiskSource: 'IPQS', mediaSummary: {}, aiSummary: {} },
  };

  const day2Report = {
    schemaVersion: 1,
    nodeUuid: 'test-node-1',
    date: '2026-09-21',
    updatedAt: '',
    v4: normalizeRawIpqa(
      {
        Info: { IP: '1.2.3.4', Country: 'Japan', Type: '广播' }, // Type change
        Score: { IPQS: 85 }, // Score increase (Critical)
        Factor: { Proxy: { IPQS: true } }, // New factor
        Media: { Netflix: { Status: '仅自制', Region: 'US' } }, // Status & region change
        extra: { customMeta: 'beta' }, // Leaf diff
      },
      'v4',
      '2026-09-21_040000.json'
    ),
    v6: null,
    summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Critical', highestRiskSource: 'IPQS', mediaSummary: {}, aiSummary: {} },
  };

  const changes = compareDailyReports(day1Report, day2Report);
  assert.ok(changes.length >= 5);

  const typeChange = changes.find(c => c.field === 'info.type');
  assert.ok(typeChange);
  assert.strictEqual(typeChange.severity, 'CRITICAL');

  const scoreChange = changes.find(c => c.field === 'scores.IPQS');
  assert.ok(scoreChange);
  assert.strictEqual(scoreChange.severity, 'CRITICAL');

  const factorChange = changes.find(c => c.field === 'factors.Proxy.IPQS');
  assert.ok(factorChange);
  assert.strictEqual(factorChange.severity, 'WARNING');

  const mediaStatusChange = changes.find(c => c.field === 'media.Netflix.status');
  assert.ok(mediaStatusChange);
  assert.strictEqual(mediaStatusChange.severity, 'CRITICAL');

  const leafDiff = changes.find(c => c.field === 'extra.customMeta');
  assert.ok(leafDiff);
  assert.strictEqual(leafDiff.before, 'alpha');
  assert.strictEqual(leafDiff.after, 'beta');
});

test('archive-store: persistence across cache operations', () => {
  const nodeUuid = 'store-test-node';
  const testReport = {
    schemaVersion: 1,
    nodeUuid,
    date: '2026-09-21',
    updatedAt: new Date().toISOString(),
    v4: null,
    v6: null,
    summary: {
      hasV4: false,
      hasV6: false,
      highestRiskCategory: 'Low',
      highestRiskSource: 'None',
      mediaSummary: {},
      aiSummary: {},
    },
  };

  saveDailyReport(nodeUuid, testReport);
  const loaded = getDailyReport(nodeUuid, '2026-09-21');
  assert.ok(loaded);
  assert.strictEqual(loaded.nodeUuid, nodeUuid);
  assert.strictEqual(loaded.date, '2026-09-21');

  const dates = listDailyDates(nodeUuid);
  assert.ok(dates.includes('2026-09-21'));

  const fleet = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    total_nodes: 1,
    ipqa_nodes: 1,
    nodes_with_risk: 0,
    nodes_with_changes_today: 0,
    latest_archive_date: '2026-09-21',
    nodes: [],
  };
  saveFleetOverview(fleet);
  const loadedFleet = getFleetOverview();
  assert.ok(loadedFleet);
  assert.strictEqual(loadedFleet.total_nodes, 1);
});

test('archive-normalize: authoritative mtimeEpoch produces true UTC timestamp and Beijing date', () => {
  const raw = { Info: { IP: '1.2.3.4' } };
  // 2026-09-21 20:00:00 UTC = 2026-09-22 04:00:00 Beijing
  const mtime = 1790020800;
  const normalized = normalizeRawIpqa(raw, 'v4', '2026-09-21_130000.json', mtime);
  assert.strictEqual(normalized.timestamp, '2026-09-21T20:00:00.000Z');
  assert.strictEqual(normalized.date, '2026-09-22');
});

test('archive-normalize: absent mtimeEpoch falls back to filename date and naive timestamp without fake Z', () => {
  const raw = { Info: { IP: '1.2.3.4' } };
  const normalized = normalizeRawIpqa(raw, 'v4', '2026-09-21_130000.json');
  assert.strictEqual(normalized.timestamp, '2026-09-21T13:00:00');
  assert.strictEqual(normalized.date, '2026-09-21');
  assert.ok(!normalized.timestamp.endsWith('Z'), 'Naive fallback must not end with Z');
});

test('archive-sync: rebuildNodeDailyReports maps manifest mtime into normalized reports', () => {
  const nodeUuid = 'mtime-test-node';
  saveRawArchive(nodeUuid, 'v4', '2026-09-21_130000.json', { Info: { IP: '1.2.3.4' } });

  const remoteEntries = [
    {
      ipVersion: 'v4',
      filename: '2026-09-21_130000.json',
      date: '2026-09-21',
      size: 100,
      mtime: 1790020800, // 20:00 UTC -> 2026-09-22 Beijing
    },
  ];

  rebuildNodeDailyReports(nodeUuid, remoteEntries);

  const report = getDailyReport(nodeUuid, '2026-09-22');
  assert.ok(report, 'Report should be indexed under 2026-09-22 via mtime');
  assert.strictEqual(report.date, '2026-09-22');
  assert.strictEqual(report.v4?.timestamp, '2026-09-21T20:00:00.000Z');
});
test('archive-diff: DNS blacklist changes are semantic alerts', () => {
  const prev = {
    schemaVersion: 1,
    nodeUuid: 'dnsbl-node',
    date: '2026-09-24',
    updatedAt: '',
    v4: normalizeRawIpqa(
      { Mail: { DNSBlacklist: { Blacklisted: 0 } } },
      'v4',
      '2026-09-24_040000.json'
    ),
    v6: null,
    summary: { hasV4: true, hasV6: false, highestRiskCategory: 'Unknown', highestRiskSource: 'None', mediaSummary: {}, aiSummary: {} },
  };
  const curr = {
    ...prev,
    date: '2026-09-25',
    v4: normalizeRawIpqa(
      { Mail: { DNSBlacklist: { Blacklisted: 3 } } },
      'v4',
      '2026-09-25_040000.json'
    ),
  };

  const changes = compareDailyReports(prev, curr);
  const dnsbl = changes.find(c => c.field === 'mail.DNSBlacklist.Blacklisted');
  assert.ok(dnsbl);
  assert.strictEqual(dnsbl.category, 'dnsbl');
  assert.strictEqual(dnsbl.severity, 'WARNING');
});


