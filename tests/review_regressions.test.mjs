import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleGetNodeArchive, handleGetNodeLatest, handleGetNodeArchives, registerApiRoutes } from '../src/api/routes.ts';
import { saveRawArchive, saveDailyReport, listDailyDates, getDailyReport, getFleetOverview, getNodeDir } from '../src/storage/archive-store.ts';
import { normalizeRawIpqa } from '../src/ipqa/archive-normalize.ts';
import { pairDailyReports } from '../src/ipqa/archive-pair.ts';
import { rebuildNodeDailyReports, syncIpqaArchives } from '../src/ipqa/archive-sync.ts';

async function isolated(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipqa-review-'));
  globalThis.__storageDir__ = dir;
  try { await run(dir); }
  finally { delete globalThis.__storageDir__; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('public archive handlers reject traversal and invalid calendar dates', () => isolated(async dir => {
  fs.mkdirSync(path.join(dir, 'ipqa', 'nodes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.json'), JSON.stringify({ secret: 'sentinel' }));
  assert.equal(handleGetNodeLatest('../../'), null);
  assert.equal(handleGetNodeArchive('valid-node', '../../../../secret'), null);
  assert.equal(handleGetNodeArchive('..\\..', '2026-10-05'), null);
  assert.equal(handleGetNodeArchive('valid-node', '2026-02-30'), null);
  const routes = new Map();
  registerApiRoutes({ route: (method, url, handler) => routes.set(`${method}:${url}`, handler) });
  const handler = [...routes.entries()].find(([key]) => key.includes('nodes/*'))[1];
  const response = { setHeader() {}, end(value) { this.body = value; } };
  await handler({ url: '/api/plugin/ipqa-alert-report/v1/nodes/../archives/../../secret' }, response);
  assert.ok(!response.body.includes('sentinel'));
}));

test('pairing keeps negative, limited and DNS meanings and the selected protocol region', () => {
  const v4 = normalizeRawIpqa({ Media: { Netflix: { Status: '未解锁', Region: 'CN' }, YouTube: { Status: '仅网页' } } }, 'v4', '2026-10-05_040000.json');
  const v6 = normalizeRawIpqa({ Media: { Netflix: { Status: '解锁', Type: 'DNS', Region: 'US' } } }, 'v6', '2026-10-05_040000.json');
  const negative = pairDailyReports([v4], [], 'n')[0].summary;
  assert.equal(negative.mediaSummary.Netflix.unlocked, false);
  assert.equal(negative.mediaSummary.YouTube.state, 'limited');
  const summary = pairDailyReports([v4], [v6], 'n')[0].summary;
  assert.equal(summary.mediaSummary.Netflix.state, 'dns');
  assert.equal(summary.mediaSummary.Netflix.region, 'US');
});

test('mtime survives remote pruning and old derived dates are removed', () => isolated(() => {
  const filename = '2026-10-04_200000.json';
  saveRawArchive('n', 'v4', filename, { Head: { IP: '192.0.2.1' } });
  rebuildNodeDailyReports('n');
  assert.deepEqual(listDailyDates('n'), ['2026-10-04']);
  const mtime = Date.parse('2026-10-04T20:00:00Z') / 1000;
  rebuildNodeDailyReports('n', [{ ipVersion: 'v4', filename, mtime }]);
  assert.deepEqual(listDailyDates('n'), ['2026-10-05']);
  rebuildNodeDailyReports('n', []);
  assert.deepEqual(listDailyDates('n'), ['2026-10-05']);
  fs.unlinkSync(path.join(getNodeDir('n'), 'raw-times.json'));
  rebuildNodeDailyReports('n', []);
  assert.equal(getDailyReport('n', '2026-10-05').v4.timestamp, '2026-10-04T20:00:00.000Z');
}));

test('archive pagination reaches dates beyond the first thirty', () => isolated(() => {
  for (let day = 1; day <= 31; day++) saveDailyReport('n', { date: `2026-10-${String(day).padStart(2, '0')}` });
  const first = handleGetNodeArchives('n', 30);
  assert.equal(first.dates.length, 30);
  assert.equal(first.hasMore, true);
  const next = handleGetNodeArchives('n', 30, first.dates.at(-1));
  assert.deepEqual(next.dates, ['2026-10-01']);
  assert.equal(next.hasMore, false);
  assert.equal(handleGetNodeArchives('../', 30).hasMore, false);
}));

test('selected-node sync preserves every configured node in the fleet overview', () => isolated(async () => {
  const nodes = [{ uuid: 'a', name: 'A' }, { uuid: 'b', name: 'B' }];
  const server = {
    getConfig: () => ({ enabled: true, all_nodes: true }),
    call: async (method) => {
      if (method === 'common:getNodes') return nodes;
      if (method === 'admin:exec') return { task_id: 'manifest' };
      if (method === 'admin:getTaskResultsByTaskId') return { results: [{ client: 'a', exit_code: 0, stdout: '__IPQA_MANIFEST_BEGIN__\n__IPQA_MANIFEST_END__' }] };
      return {};
    },
  };
  const result = await syncIpqaArchives(server, { reason: 'manual', selectedNodeUuids: ['a'] });
  assert.equal(result.nodes.length, 1);
  const overview = getFleetOverview();
  assert.equal(overview.total_nodes, 2);
  assert.deepEqual(overview.nodes.map(node => node.uuid).sort(), ['a', 'b']);
}));
