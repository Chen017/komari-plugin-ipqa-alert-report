import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerApiRoutes, handleGetNodeChanges } from '../src/api/routes.ts';
import { saveDailyReport, getDailyReport } from '../src/storage/archive-store.ts';

test('theme change feeds follow the current notification severity without rewriting archives', async () => {
  const previousStorageDir = globalThis.__storageDir__;
  const storageDir = fs.mkdtempSync(path.join(process.cwd(), '.test-severity-'));
  globalThis.__storageDir__ = storageDir;
  try {
    const changes = ['INFO', 'WARNING', 'CRITICAL'].map(severity => ({
      date: '2026-10-22', nodeUuid: 'severity-node', ipVersion: 'IPv4',
      category: 'score', severity, field: 'scores.IPQS', description: severity,
    }));
    saveDailyReport('severity-node', {
      schemaVersion: 1, nodeUuid: 'severity-node', date: '2026-10-22',
      updatedAt: '2026-10-22T00:00:00Z', v4: null, v6: null,
      summary: { hasV4: false, hasV6: false, highestRiskCategory: 'Unknown', highestRiskSource: 'None', mediaSummary: {}, aiSummary: {} },
      changesFromPrevious: changes,
    });
    const routes = new Map();
    const rpcMethods = new Map();
    let minSeverity = 'CRITICAL';
    let configUnavailable = false;
    registerApiRoutes({
      getConfig: async () => {
        if (configUnavailable) throw new Error('Configuration unavailable');
        return { min_severity: minSeverity };
      },
      route: (method, route, handler) => routes.set(`${method}:${route}`, handler),
      registerRPC: (name, handler) => rpcMethods.set(name, handler),
    });
    const handler = routes.get('GET:/api/plugin/ipqa-alert-report/v1/nodes/*action');
    async function requestChanges() {
      const response = { statusCode: 0, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
      await handler({ context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/nodes/severity-node/changes' }, response);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['Cache-Control'], 'private, no-store');
      return JSON.parse(response.body).changes.map(change => change.severity);
    }
    assert.deepEqual(await requestChanges(), ['CRITICAL']);
    minSeverity = 'WARNING';
    assert.deepEqual(await requestChanges(), ['WARNING', 'CRITICAL']);
    minSeverity = 'INFO';
    assert.deepEqual(await requestChanges(), ['INFO', 'WARNING', 'CRITICAL']);
    minSeverity = ' critical ';
    assert.deepEqual(await requestChanges(), ['CRITICAL']);
    const rpcResult = await rpcMethods.get('plugin:ipqaGetNodeChanges')({ uuid: 'severity-node' });
    assert.deepEqual(rpcResult.changes.map(change => change.severity), ['CRITICAL']);
    assert.equal(getDailyReport('severity-node', '2026-10-22').changesFromPrevious.length, 3);
    assert.equal(handleGetNodeChanges('severity-node').changes.length, 3);
    assert.deepEqual(handleGetNodeChanges('missing-node', 'CRITICAL').changes, []);
    configUnavailable = true;
    const failedResponse = { statusCode: 0, body: '', setHeader() {}, end(body) { this.body = body; } };
    await handler({ context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/nodes/severity-node/changes' }, failedResponse);
    assert.equal(failedResponse.statusCode, 500);
    assert.equal(JSON.parse(failedResponse.body).changes, undefined, 'Config errors must not silently widen CRITICAL to INFO');
  } finally {
    globalThis.__storageDir__ = previousStorageDir;
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
