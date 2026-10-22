import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAccess, redactPublic } from '../src/api/public-access.ts';
import { createRpcJobs } from '../src/rpc-jobs.ts';
import { compareDailyReports } from '../src/ipqa/archive-diff.ts';
import { normalizeRawIpqa } from '../src/ipqa/archive-normalize.ts';
import { pairDailyReports } from '../src/ipqa/archive-pair.ts';
import { registerApiRoutes, filterFleetOverview } from '../src/api/routes.ts';

test('anonymous visibility fails closed and never includes hidden nodes or IP payloads', async () => {
  const server = { call: async method => method === 'public:getPublicSettings' ? { private_site: false } : [{ uuid: 'public' }, { uuid: 'hidden', hidden: true }] };
  assert.deepEqual([...(await publicAccess(server, {}))], ['public']);
  await assert.rejects(publicAccess({ call: async () => ({ private_site: true }) }, {}));
  await assert.rejects(publicAccess({ call: async () => { throw Error('offline'); } }, {}));
  assert.deepEqual(redactPublic({ info: { ip: '198.51.100.1', country: 'US' }, extra: { IP: 'secret' }, field: 'info.ip', before: 'secret', after: 'secret', description: 'secret' }), { info: { country: 'US' }, field: 'info.ip', description: 'IP 地址发生变更' });
  assert.equal(filterFleetOverview({ nodes: [{ uuid: 'hidden' }] }, []).nodes.length, 0);
});

test('real media downgrades remain critical and unknown factors never imply recovery', () => {
  const report = (raw, date) => pairDailyReports([normalizeRawIpqa(raw, 'v4', `${date}_040000.json`)], [], 'n')[0];
  const before = report({ Media: { Netflix: { Status: 'Yes' } }, Factor: { Proxy: { IPQS: true } } }, '2026-10-21');
  for (const status of ['No', 'Blocked', '仅网页']) {
    const changes = compareDailyReports(before, report({ Media: { Netflix: { Status: status } }, Factor: { Proxy: { IPQS: null } } }, '2026-10-22'));
    assert.equal(changes.find(change => change.category === 'media').severity, 'CRITICAL');
    assert.equal(changes.some(change => change.category === 'factor'), false);
  }
});

test('RPC cache callbacks return plain values; asynchronous jobs expose final state', async () => {
  const callbacks = new Map();
  registerApiRoutes({ registerRPC: (name, handler) => callbacks.set(name, handler) }, 'CRITICAL');
  for (const name of ['plugin:ipqaGetCapabilities', 'plugin:ipqaGetOverview', 'plugin:ipqaGetNodes']) assert.equal(callbacks.get(name)({}) instanceof Promise, false);
  const jobs = createRpcJobs();
  const submitted = jobs.submit(async () => 42);
  assert.equal(submitted instanceof Promise, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(submitted.job_id).result, 42);
  const failed = jobs.submit(async () => { throw Error('failed'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(failed.job_id).status, 'failed');
});
